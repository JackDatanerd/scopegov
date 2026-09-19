-- ============================================================
-- ScopeGov — Migration 006: MFA backup codes
-- (FIX, cosmetic, deep audit Auth+MFA re-pass: this header called itself
-- "Migration 003" — stale from before a renumbering; the file itself has
-- always been 006. lib/auth/mfa-policy.ts's comment citing this file by
-- its correct 006 name was already right; only this header was wrong.)
-- Account security / 2FA. TOTP enrollment, challenge, and factor
-- management are handled entirely by Supabase Auth's native MFA
-- (auth.mfa_factors, auth.mfa_challenges — not application tables).
-- The one piece Supabase does not provide natively is backup /
-- recovery codes, so that's the only new table this phase needs.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_mfa_backup_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- SHA-256 hex digest of the code. Codes are high-entropy, single-use,
  -- server-generated tokens (not user-chosen secrets), so a plain fast
  -- hash is the correct tool here — the same reasoning applies as for
  -- API-key storage. bcrypt/scrypt is for low-entropy human passwords.
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A user's *current* generation of backup codes is looked up constantly
-- (every recovery attempt); a partial index on the unused rows keeps that
-- lookup cheap without ever scanning consumed codes.
CREATE INDEX IF NOT EXISTS user_mfa_backup_codes_active
  ON public.user_mfa_backup_codes(user_id) WHERE used_at IS NULL;

ALTER TABLE public.user_mfa_backup_codes ENABLE ROW LEVEL SECURITY;

-- Users can see their own backup code metadata (used_at/created_at) —
-- never the hash itself in any client-facing query path; the API routes
-- that touch code_hash always use the service-role client.
CREATE POLICY "own_mfa_backup_codes" ON public.user_mfa_backup_codes
  FOR SELECT USING (auth.uid() = user_id);

-- ============================================================
-- Notes on why nothing else changed in this migration:
--
-- 1. Audit export (Phase 1) needs zero schema changes. audit_log already
--    carries everything the export needs (event_type, entity_type,
--    entity_id, metadata, actor, created_at). Filtering an export by
--    project is done by resolving sow_documents/change_orders/
--    guardian_flags/guardian_checks IDs for that project at query time
--    (all of those tables already carry project_id) rather than adding a
--    denormalized project_id column to audit_log and touching the ~30
--    call sites that already write to it — same correctness, zero
--    regression surface on a table that exists specifically to be a
--    trustworthy, append-only record.
--
-- 2. No new `Permission` was added for audit export — VIEW_AUDIT_LOG
--    already exists, already gates the /settings/audit page, and is
--    already admin-only by default on every preset role. Exporting is a
--    stricter form of the same read access, so it reuses the same gate
--    rather than forcing a role-matrix backfill for a permission that
--    would always be set identically to VIEW_AUDIT_LOG anyway.
--
-- 3. Which permissions *require* MFA (VIEW_ALL_PROJECTS, VIEW_AUDIT_LOG,
--    MANAGE_BILLING, MANAGE_ROLES, MANAGE_WORKSPACE_SETTINGS,
--    DELETE_PROJECTS) is intentionally a fixed policy in application code
--    (lib/auth/mfa-policy.ts), not a configurable table. The spec draft
--    floated a MANAGE_MFA_POLICY permission for making this configurable
--    per-workspace — deliberately not built. A configurable "which roles
--    need MFA" toggle is an easy way for an agency to quietly weaken its
--    own governance story right before the procurement call that was the
--    entire reason for building this. Fixed and non-negotiable is the
--    correct default for a compliance feature; add a real settings
--    surface later only if a customer needs something more granular than
--    "governance-sensitive permissions require MFA."
-- ============================================================
