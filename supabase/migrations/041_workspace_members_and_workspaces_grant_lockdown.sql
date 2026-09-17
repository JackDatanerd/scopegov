-- ============================================================
-- ScopeGov — Migration 041: workspace_members full lockdown +
-- workspaces write/anon-select lockdown
--
-- FINDING (deep audit, RLS+permissions section, standalone pass,
-- from-scratch Postgres 16 replay + empirical privilege checks):
--
-- (A) workspace_members — the actual access-control mapping table
--     (workspace_id / user_id / role_id / status) — is the ONE
--     sensitive table in this schema that never got the
--     belt-and-braces REVOKE ALL treatment every other table
--     received: 37 tables in migration 010's original sweep, 2 more
--     (workspace_secrets, processed_webhook_events) in 013/026, and
--     3 more (ai_usage_log, ops_alert_state, portal_action_log) in
--     033 specifically because they were "one careless future policy
--     away from being the next processed_webhook_events." That same
--     reasoning applies here with a far higher ceiling: this table
--     was left with full default Supabase table-wide grants
--     (SELECT/INSERT/UPDATE/DELETE) intact for BOTH anon AND
--     authenticated, confirmed empirically via a from-scratch replay
--     of all 40 migrations against a faithful Supabase-bootstrap
--     baseline. Not exploitable today — its only policy
--     ("members_own", 001_initial_schema.sql) is SELECT-only, and
--     Postgres RLS defaults to deny for any command with no
--     applicable policy, confirmed empirically with real INSERT/
--     UPDATE escalation attempts (self-promotion into another
--     workspace, self-elevation of role_id) against live fixture
--     data — all correctly blocked. But a single future policy
--     addition here (an INSERT/UPDATE policy scoped even narrowly,
--     e.g. "let a member update their own last_seen_at") would land
--     directly on top of these dangling grants and become a
--     self-service privilege-escalation primitive, not just a data
--     leak — a much higher blast radius than any other table this
--     pattern has been applied to. Confirmed via grep that no
--     client-side or session-bound code path anywhere in the app
--     queries this table directly (every read/write site uses
--     service_role, which bypasses RLS/grants entirely regardless).
--
-- (B) workspaces — migration 032 column-narrowed SELECT for
--     `authenticated` only, but:
--       (i)  never touched `anon` at all — anon still holds the
--            original default table-wide SELECT grant (every
--            column, no narrowing), confirmed empirically. Not
--            exploitable (workspaces_member's policy requires
--            auth.uid() to match an active membership row; auth.uid()
--            is NULL for anon, so RLS returns zero rows regardless of
--            grant width) — but a real completeness gap, the same
--            class 032 itself was written to close for authenticated.
--       (ii) never touched INSERT/UPDATE/DELETE for `authenticated`
--            at all — authenticated still holds UPDATE (and INSERT/
--            DELETE) on every single column, including the exact
--            four fields 032 fought to hide from reads (tax_id,
--            legal_address, default_payment_instructions,
--            agency_signature_data). Not exploitable today (no
--            INSERT/UPDATE/DELETE policy exists on this table either
--            — confirmed empirically with real UPDATE attempts on
--            both own and another tenant's workspace row, both
--            silently affecting 0 rows), but it directly undermines
--            032's own stated goal: any future UPDATE policy on this
--            table (a plausible one — "let MANAGE_WORKSPACE_SETTINGS
--            holders rename/rebrand via direct RLS" is exactly the
--            kind of feature this app might add) would need its own
--            column-scoping to avoid instantly exposing write access
--            to those four fields to every member, a step easy to
--            miss precisely because 032 already made it look like
--            this table was handled.
--
-- Confirmed via grep (same as A) that no client-side or session-bound
-- code path anywhere in the app queries `workspaces` directly either
-- — all 8 pages/routes that read it use service_role.
-- ============================================================

-- ── (A) workspace_members: full belt-and-braces lockdown ──────────
-- Unlike ai_usage_log/ops_alert_state/portal_action_log (033), this
-- table DOES have a real SELECT policy ("members_own") — but since
-- no app code ever reaches it through the session-bound client (all
-- reads go through service_role), there is no legitimate use of the
-- table-wide grant to preserve. Full revoke, same shape as 033.
REVOKE ALL ON public.workspace_members FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.workspace_members TO service_role;

-- ── (B) workspaces: close both gaps ─────────────────────────────────
-- (i) anon never had SELECT revoked at all — revoke it outright, same
--     as (A). No anonymous-access model exists for this table.
REVOKE ALL ON public.workspaces FROM anon;

-- (ii) authenticated: revoke everything (undoes 032's narrower
--      SELECT-only revoke plus closes the never-touched INSERT/
--      UPDATE/DELETE), then re-grant only the same safe SELECT
--      column list 032 already established. No INSERT/UPDATE/DELETE
--      grant is re-added — every existing write site already uses
--      service_role, so there is nothing for `authenticated` to
--      legitimately do here.
REVOKE ALL ON public.workspaces FROM authenticated;

GRANT SELECT (
  id, name, slug, slug_changed_at, agency_name, brand_colour,
  logo_storage_path, industry, currency, timezone, sow_language,
  governing_law, proactive_risk_threshold, proactive_risk_alerts_enabled,
  plan_tier, trial_ends_at, onboarding_completed_at, first_sow_signed_at,
  deleted_at, created_by, created_at, updated_at, phone, website,
  trial_cap_exempt
) ON public.workspaces TO authenticated;

GRANT ALL ON public.workspaces TO service_role;
