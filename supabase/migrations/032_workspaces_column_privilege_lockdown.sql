-- ============================================================
-- ScopeGov — Migration 032: column-privilege lockdown on workspaces
--
-- FINDING (deep audit, RLS+permissions section, standalone pass):
-- "workspaces_member" (001_initial_schema.sql) is a row-level-only
-- policy — USING (id IN (SELECT workspace_id FROM workspace_members
-- WHERE user_id = auth.uid() AND status = 'active')). It checks
-- ACTIVE MEMBERSHIP only, never any in-app permission. Since
-- `workspaces` was correctly left out of migration 010's blanket
-- REVOKE ALL (it needs *some* columns readable by every member —
-- agency_name, brand_colour, etc.), `authenticated` still holds
-- Supabase's default table-wide SELECT grant on every column,
-- including four added after the row-policy was written:
--
--   - agency_signature_data (002_signatures.sql): the agency's
--     drawn signature, auto-applied to every SOW/CO from then on
--   - tax_id, legal_address, default_payment_instructions
--     (011_document_billing_identity.sql)
--
-- app/api/workspace/branding/route.ts already gates *writing*
-- agency_signature_data behind MANAGE_WORKSPACE_SETTINGS — but
-- nothing gates *reading* any of these four, at either layer.
-- Empirically confirmed on a from-scratch replay: a zero-permission
-- member (no MANAGE_WORKSPACE_SETTINGS, e.g. the default "Designer"
-- role) can, using nothing but their own normal login session,
-- call:
--
--   GET /rest/v1/workspaces?select=tax_id,legal_address,
--     default_payment_instructions,agency_signature_data
--     &id=eq.<own-workspace-id>
--   apikey: <public anon key>
--   Authorization: Bearer <their own session JWT>
--
-- and read all four straight out of the database — including the
-- raw base64 image bytes of the agency's binding signature, letting
-- any staff member extract and reuse it. Same class of gap as
-- jwt_secret (013_workspace_secret_isolation.sql), just on two
-- columns added before that fix and two added after — 013 never
-- re-swept the rest of this table for the same pattern.
--
-- Unlike jwt_secret (a true secret with zero legitimate member-facing
-- use, worth its own table), these four are ordinary business fields
-- with a real, if narrower, audience — moving them to a satellite
-- table would mean re-plumbing every PDF/portal/settings read site
-- that already correctly joins them off `workspaces` via the
-- service-role client. Confirmed by inspecting every read/write site
-- (19 files: settings page, workspace/settings + branding routes,
-- every SOW/CO/invoice PDF generator, every portal route, finalize-
-- co.ts) that NONE of them use the session-scoped client for this
-- table — all 19 already go through service_role, which this
-- migration doesn't touch. So the correct, minimal fix is the same
-- one already proven for users.UPDATE (019_section_audit_fixes.sql):
-- REVOKE ALL first (a bare column-level REVOKE cannot narrow an
-- existing table-wide GRANT — that mistake is exactly what shipped,
-- and had to be fixed later, on a sibling ScopeShield product), then
-- GRANT SELECT back on an explicit column allow-list.
--
-- `phone` and `website` are left readable — ordinary, already-
-- semi-public business contact info, not the identity-document /
-- payment-instruction / signature material the other four represent.
-- ============================================================

REVOKE SELECT ON public.workspaces FROM authenticated;

GRANT SELECT (
  id, name, slug, slug_changed_at, agency_name, brand_colour,
  logo_storage_path, industry, currency, timezone, sow_language,
  governing_law, proactive_risk_threshold, proactive_risk_alerts_enabled,
  plan_tier, trial_ends_at, onboarding_completed_at, first_sow_signed_at,
  deleted_at, created_by, created_at, updated_at, phone, website,
  trial_cap_exempt
) ON public.workspaces TO authenticated;

-- agency_signature_data, tax_id, legal_address, and
-- default_payment_instructions are now unreachable for `authenticated`
-- regardless of RLS row visibility — only service_role (which every
-- existing app read/write site already uses for this table) can
-- select them.
