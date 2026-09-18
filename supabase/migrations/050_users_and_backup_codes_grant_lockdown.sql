-- 050_users_and_backup_codes_grant_lockdown.sql
--
-- FIX (deep audit, RLS+permissions section, independent re-pass —
-- CRITICAL, empirically confirmed): public.users is one of only 4 tables
-- in the whole schema with any RLS policy at all (`users_own FOR ALL
-- USING (auth.uid() = id)`). Migration 019 correctly narrowed UPDATE to
-- (name, updated_at) once it noticed users was never swept into migration
-- 010's blanket REVOKE ALL — but it left DELETE untouched, and unlike the
-- fragility-only findings elsewhere in this schema, this one is LIVE:
-- users_own's `FOR ALL` actively permits DELETE, it isn't merely a
-- dangling grant waiting on a policy that doesn't exist yet.
--
-- Verified against a full from-scratch Postgres 16 replay of every prior
-- migration plus live fixture data: a freshly-signed-up user, before
-- creating or joining their first workspace (and therefore before any
-- workspace_members row or audit_log row references them — login-event/
-- route.ts's own code skips logging when there's no workspace to
-- attribute to), can call `DELETE /rest/v1/users?id=eq.<self>` with
-- nothing but their own session JWT and it succeeds outright. Their
-- Supabase Auth session survives (they stay logged in) but their
-- public.users row — and everything downstream that assumes it exists —
-- is gone for good, since handle_new_user() only fires once, on
-- auth.users INSERT at signup, never again on login. Once a real
-- workspace_members row exists the FK (NO ACTION) blocks it, but that's
-- an accident of schema shape, not an intentional safeguard, and no
-- feature in this app performs or relies on self-service account
-- deletion at all.
--
-- Same pass also confirmed `anon` still holds the entire original,
-- untouched default grant (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/
-- REFERENCES/TRIGGER, every column) on both `users` and
-- `user_mfa_backup_codes` — not currently reachable (auth.uid() is NULL
-- for anon, so users_own's row filter blocks it, and
-- user_mfa_backup_codes has no INSERT/UPDATE/DELETE policy at all, so
-- Postgres denies by default) but the exact same "one future policy away
-- from a problem" fragility migration 041 already closed for
-- workspace_members and workspaces — just never extended to these two.
-- Closing both here for the same belt-and-braces reason 041 gives.

-- public.users: revoke everything from anon (no legitimate anon access
-- exists or ever has); revoke DELETE from authenticated (no feature uses
-- or should use it) while keeping the SELECT (own row, all columns — no
-- sensitive columns here) and column-scoped UPDATE(name, updated_at)
-- migration 019 already established.
REVOKE ALL ON public.users FROM anon;
REVOKE DELETE ON public.users FROM authenticated;

-- public.user_mfa_backup_codes: revoke everything from anon; revoke the
-- unused INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grants from
-- authenticated (all app writes to this table already go through the
-- service-role client — see api/auth/mfa/enroll, /backup-codes,
-- /recover — RLS has no policy permitting any of these commands for
-- authenticated regardless), keeping the column-scoped
-- SELECT(id, used_at, created_at) migration 040 already established.
REVOKE ALL ON public.user_mfa_backup_codes FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.user_mfa_backup_codes FROM authenticated;
