-- ============================================================
-- ScopeGov — Migration 040: column-privilege lockdown on
-- user_mfa_backup_codes
--
-- FINDING (deep audit, Auth+MFA independent re-pass): migration 006's own
-- comment on "own_mfa_backup_codes" claims a user can see their own
-- backup-code metadata (used_at/created_at) "never the hash itself in any
-- client-facing query path; the API routes that touch code_hash always
-- use the service-role client." That's true of this app's own routes,
-- but irrelevant to what the policy itself actually allows — RLS is
-- row-level, not column-level, and nothing here narrowed the columns.
-- `authenticated` still holds Supabase's default table-wide SELECT grant,
-- so the policy as written lets any logged-in user call:
--
--   GET /rest/v1/user_mfa_backup_codes?select=code_hash,used_at
--     &user_id=eq.<own-user-id>
--   apikey: <public anon key>
--   Authorization: Bearer <their own session JWT>
--
-- and read the SHA-256 hash of their own backup codes straight out of the
-- database, directly contradicting the comment. Same class of gap as
-- workspaces' agency_signature_data/tax_id (032) and users.UPDATE (019) —
-- a table-wide grant surviving a row-scoped policy that was only ever
-- meant to cover a subset of columns.
--
-- Practical severity here is low (a user reading the hash of their OWN
-- high-entropy — 32^10 combinations, see lib/utils/backup-codes.ts —
-- backup codes doesn't let them reverse the original code or act against
-- anyone but themselves, an account they already fully control), but the
-- policy should actually match what its own comment claims, and
-- code_hash has zero legitimate client-facing use per that same comment.
-- Same fix shape as 019/032: REVOKE the table-wide grant, GRANT SELECT
-- back on an explicit allow-list.
-- ============================================================

REVOKE SELECT ON public.user_mfa_backup_codes FROM authenticated;

GRANT SELECT (id, used_at, created_at) ON public.user_mfa_backup_codes TO authenticated;

-- code_hash and user_id are now unreachable for `authenticated` regardless
-- of RLS row visibility — only service_role (which every existing
-- read/write site for this table already uses) can select them.
