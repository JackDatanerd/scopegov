-- ============================================================
-- ScopeGov — Migration 042: cap + sanitize user name at the
-- single point it's actually set (handle_new_user trigger)
--
-- FINDING (deep audit, Auth+MFA section, standalone pass): neither
-- signup entry point (app/(auth)/signup/page.tsx's direct
-- supabase.auth.signUp(), or app/api/team/invite/[token]/signup/
-- route.ts) ever capped the length of the user-supplied `name`. Both
-- only trim it. The value flows straight into
-- auth.users.raw_user_meta_data, and from there — via this trigger,
-- unchanged since 019_section_audit_fixes.sql — into
-- public.users.name, which is then used unbounded everywhere: JWT
-- claims, audit_log.actor_name, every email template's "From" display
-- name (lib/email/templates.ts's BRAND_FROM), and UI throughout the
-- app. Every structurally comparable field in this codebase
-- (agency_name, workspace name) already goes through
-- sanitizeDisplayName() (lib/utils/sanitize.ts) — a 120-char cap that
-- also strips CR/LF/control characters specifically because
-- unescaped names reach email header contexts. Signup never picked up
-- that convention on either entry point.
--
-- This trigger is the one place both entry points' name ends up
-- passing through on the way into public.users, so fixing it here
-- closes the gap for both at once (and any future entry point) rather
-- than duplicating the same logic at each call site. Mirrors
-- sanitizeDisplayName()'s own behavior as closely as SQL reasonably
-- allows: collapse CR/LF/control chars and runs of whitespace, trim,
-- cap at 120. The route-level fix (separate migration-less code
-- change) additionally calls the real sanitizeDisplayName() before
-- ever reaching this trigger, so this is belt-and-braces for the
-- direct-signup path (which has no server route of its own to sanitize
-- in) and a second, independent backstop for invite-signup.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  clean_name text;
BEGIN
  clean_name := NULLIF(
    TRIM(
      regexp_replace(
        regexp_replace(COALESCE(NEW.raw_user_meta_data->>'name', ''), '[\r\n\x00-\x1F\x7F]', ' ', 'g'),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );

  INSERT INTO public.users (id, email, name, email_verified_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(LEFT(clean_name, 120), split_part(NEW.email, '@', 1)),
    CASE WHEN NEW.email_confirmed_at IS NOT NULL THEN NEW.email_confirmed_at ELSE NULL END
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        name  = CASE WHEN public.users.name = '' THEN EXCLUDED.name ELSE public.users.name END,
        email_verified_at = COALESCE(public.users.email_verified_at, EXCLUDED.email_verified_at);
  RETURN NEW;
END;
$$;

-- One-time backfill for any account that already signed up with a
-- name longer than the new cap, same shape as 019's blank-name
-- backfill. Uses the same collapse-whitespace/strip-control-chars
-- logic as the trigger above for consistency, in case a name
-- exceeding 120 chars also happens to contain a raw newline.
UPDATE public.users
SET name = LEFT(
  TRIM(
    regexp_replace(
      regexp_replace(name, '[\r\n\x00-\x1F\x7F]', ' ', 'g'),
      '\s+', ' ', 'g'
    )
  ),
  120
)
WHERE LENGTH(name) > 120 OR name ~ '[\r\n\x00-\x1F\x7F]';
