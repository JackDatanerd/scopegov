-- ============================================================
-- ScopeGov — Migration 033: Section 1+2 re-pass hardening
--
-- (A) Belt-and-braces REVOKE for three tables that never got it.
--     Migration 010 established the pattern for every table that relies
--     on "RLS enabled, zero policies" as its deny-all mechanism: enable
--     RLS AND explicitly REVOKE ALL from PUBLIC/anon/authenticated, so a
--     future migration that accidentally adds a permissive policy still
--     can't leak data through a table grant nobody meant to hand out.
--     Migration 026 went back and applied this retroactively to
--     processed_webhook_events specifically because it had been missed.
--     The same omission exists for three more tables added at various
--     points around that fix: ai_usage_log (012, before 010's sweep
--     could catch it — it didn't exist yet), ops_alert_state (025) and
--     portal_action_log (030), both added after 026 without picking the
--     pattern back up. None of these three are exploitable today (RLS
--     enabled + zero policies is deny-all regardless of grants), but
--     they're one careless future policy away from being the next
--     processed_webhook_events, which is exactly the risk this pattern
--     exists to close off in advance rather than after the fact.
--
-- (B) Column-level lockdown on user_mfa_backup_codes.code_hash.
--     "own_mfa_backup_codes" (006_mfa_backup_codes.sql) is a row-only
--     policy (`auth.uid() = user_id`) with a comment stating the hash is
--     "never the hash itself in any client-facing query path" — but
--     nothing enforces that at the database layer. `authenticated` still
--     holds the table-wide default SELECT grant on every column,
--     including code_hash, so a user's own hash is reachable via a
--     direct PostgREST call:
--       GET /rest/v1/user_mfa_backup_codes?select=code_hash&user_id=eq.<self>
--     Real-world exploitability is low — this only ever returns the
--     caller's OWN hash, and anyone in a position to make that call
--     already has a live session (at which point offline-cracking a
--     ~51-bit-entropy hash buys an attacker nothing they don't already
--     have) — but it directly contradicts the migration's own stated
--     intent and is inconsistent with the column-lockdown pattern this
--     schema applies rigorously elsewhere (users.UPDATE in 019,
--     workspaces.SELECT in 032). Same fix shape: REVOKE then GRANT back
--     an explicit allow-list that excludes the one sensitive column.
-- ============================================================

-- ── (A) Belt-and-braces REVOKE for the three missed tables ─────────────
ALTER TABLE public.ai_usage_log     ENABLE ROW LEVEL SECURITY; -- already set (012); no-op, kept for clarity
ALTER TABLE public.ops_alert_state  ENABLE ROW LEVEL SECURITY; -- already set (025); no-op, kept for clarity
ALTER TABLE public.portal_action_log ENABLE ROW LEVEL SECURITY; -- already set (030); no-op, kept for clarity

REVOKE ALL ON
  public.ai_usage_log,
  public.ops_alert_state,
  public.portal_action_log
FROM PUBLIC, anon, authenticated;

GRANT ALL ON
  public.ai_usage_log,
  public.ops_alert_state,
  public.portal_action_log
TO service_role;

-- ── (B) Column-level lockdown on user_mfa_backup_codes ──────────────────
REVOKE SELECT ON public.user_mfa_backup_codes FROM authenticated;

GRANT SELECT (id, user_id, used_at, created_at) ON public.user_mfa_backup_codes TO authenticated;

-- code_hash is now unreachable for `authenticated` regardless of RLS row
-- visibility — only service_role (which every existing read/write site
-- for this table already uses) can select it.
