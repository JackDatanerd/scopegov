-- 019_section_audit_fixes.sql
-- Section-by-section re-audit (Auth+MFA, RLS+permissions, Workspace
-- lifecycle, Onboarding) — schema-level fixes. App-code fixes for the
-- same findings live in the accompanying commit.

-- ── FIX (Section 1, signup blank-name gap) ─────────────────────────────
-- app/(auth)/signup/page.tsx calls supabase.auth.signUp() directly from
-- the browser — there is no server route in front of it, so the form's
-- `required` attribute on the name field is the ONLY check, trivially
-- bypassed by calling Supabase's auth endpoint directly with an empty or
-- whitespace-only name. handle_new_user() then stored '' verbatim.
-- api/team/invite/[token]/signup/route.ts already learned this lesson
-- and validates name?.trim() server-side — this brings the direct-signup
-- path to the same standard by falling back to the email's local part
-- (matching what the app already trusts as a display fallback via
-- getSession()'s `u?.name || user.email!` chain, just persisted instead
-- of recomputed every read). Also trims whatever name IS supplied so
-- " " doesn't sneak through as an empty-but-truthy string.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.users (id, email, name, email_verified_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NULLIF(TRIM(NEW.raw_user_meta_data->>'name'), ''),
      split_part(NEW.email, '@', 1)
    ),
    CASE WHEN NEW.email_confirmed_at IS NOT NULL THEN NEW.email_confirmed_at ELSE NULL END
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        name  = CASE WHEN public.users.name = '' THEN EXCLUDED.name ELSE public.users.name END,
        email_verified_at = COALESCE(public.users.email_verified_at, EXCLUDED.email_verified_at);
  RETURN NEW;
END;
$$;

-- One-time backfill for any account that already signed up with a blank
-- name before this fix. Uses the same email-local-part fallback.
UPDATE public.users
SET name = split_part(email, '@', 1)
WHERE TRIM(name) = '';

-- ── FIX (Section 2, Finding 1) ──────────────────────────────────────────
-- "users_own" (migration 001) is `FOR ALL USING (auth.uid() = id)` with
-- no WITH CHECK, so Postgres uses that same USING expression to gate
-- INSERT/UPDATE too — meaning the ONLY constraint on updating your own
-- row is `id = auth.uid()`. Nothing constrains the VALUES. Since
-- public.users was never added to migration 010's blanket REVOKE ALL
-- (unlike billing/roles/etc.), `authenticated` still holds Supabase's
-- default table-level UPDATE grant on every column. Concretely, any
-- logged-in user could PATCH /rest/v1/users?id=eq.<self> directly and
-- set active_workspace_id to ANY workspace UUID (letting the 4 MFA
-- routes' resolveActiveWorkspaceId() — which trusts this column with no
-- membership check — write fabricated audit_log/notifications rows into
-- a workspace they don't belong to), or rewrite their own email/name to
-- something never verified through Supabase Auth's confirmation flow
-- (getSession() builds session.email/session.name from THIS row before
-- falling back to the Auth-verified value, and every logAudit() call
-- trusts session.email as the actor's identity).
--
-- Fix: column-level privilege lockdown, same pattern already used for
-- workspace_secrets (013) — RLS stays row-scoped to your own id, but the
-- self-service UPDATE path is restricted to the two columns a user is
-- actually meant to self-manage. active_workspace_id, email, and
-- email_verified_at are now writable only by service_role (every
-- legitimate writer — workspace/switch, workspace/create, workspace/
-- leave, the auth callback, backup-code recovery — already uses the
-- service client for these).
REVOKE UPDATE ON public.users FROM authenticated;
GRANT UPDATE (name, updated_at) ON public.users TO authenticated;

-- ── FIX (Section 3, Finding 3) ──────────────────────────────────────────
-- workspace/create had no cap on trial-workspace creation per user — an
-- attacker (or just an ordinary user) could reset their 14-day trial
-- indefinitely by creating a new workspace whenever the old one expired.
-- One active (non-deleted) trial workspace per creator, DB-enforced.
--
-- Live production data already violates this in at least one case
-- (found running this migration — a CREATE UNIQUE INDEX against
-- pre-existing duplicates fails rather than silently corrupting
-- anything, which is exactly why it's a plain index and not a
-- destructive cleanup). Rather than guess which of a creator's existing
-- trial workspaces is "the real one" and delete or repurpose the rest,
-- grandfather every currently-existing violation in place — nothing
-- existing is touched, deleted, or has its plan_tier changed — and only
-- enforce the cap on workspaces that don't carry the exemption. New
-- workspaces created via the app never set this column, so it defaults
-- to false and they're fully subject to the cap; only duplicates that
-- already existed as of this migration are exempted.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS trial_cap_exempt boolean NOT NULL DEFAULT false;

-- For each creator with more than one active trial workspace, keep the
-- single MOST RECENTLY created one subject to the cap and exempt the
-- rest — the newest one is treated as "the current trial" going
-- forward, since it's the one most likely to still be the one actually
-- in use; the others keep working exactly as before, just outside the
-- new constraint.
WITH ranked AS (
  SELECT id, created_by,
         row_number() OVER (PARTITION BY created_by ORDER BY created_at DESC) AS rn
  FROM public.workspaces
  WHERE plan_tier = 'trial' AND deleted_at IS NULL
)
UPDATE public.workspaces w
SET trial_cap_exempt = true
FROM ranked r
WHERE w.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_trial_per_creator
  ON public.workspaces (created_by)
  WHERE plan_tier = 'trial' AND deleted_at IS NULL AND trial_cap_exempt = false;
