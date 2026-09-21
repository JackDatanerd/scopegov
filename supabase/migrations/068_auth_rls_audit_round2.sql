-- ============================================================
-- ScopeGov — Migration 068
-- Auth + MFA and RLS + permissions: second independent-audit round.
-- Idempotent (CREATE OR REPLACE / IF NOT EXISTS / catalog-guarded). Run AFTER 067.
--
--  1. Atomic auth-attempt ledger (auth_attempt_begin / _release). The old
--     check-then-act limiter let a burst of parallel guesses all pass the
--     check before any failure was recorded.
--  2. Supabase Auth HOOKS (hook_mfa_verification_attempt,
--     hook_password_verification_attempt). The app-route throttle only
--     protects calls that go through the app's own routes; a password-only
--     session can call GoTrue's MFA endpoints directly with the public anon
--     key. The hooks enforce the lockout INSIDE GoTrue, where it can't be
--     skipped. Enabling them (Auth -> Hooks) needs the Supabase Team or Enterprise plan;
--     until then they sit unused and harmless — see
--     README §1.3.
--  3. Server-side sign-in audit: AFTER INSERT / UPDATE OF aal trigger on
--     auth.sessions. Sign-in events used to be reported BY THE BROWSER, so an
--     attacker who talks to GoTrue directly left no trail.
--  4. Session management helpers (list / revoke), user_has_password(),
--     step_up_grants, session_seen.
--  5. issue_backup_codes(): retire-old + insert-new in ONE transaction.
--  6. public.users.name: normalise + CHECK, and drop the direct-write path.
--  7. Grant hygiene: cron_heartbeats + every table that drifted, default
--     privileges for new tables, storage buckets (logos / flag-evidence) with
--     mime + size limits.
--  8. Stale EXPORT_DATA permission key removed (it was the only thing
--     accidentally stopping an all-permissions admin from acting on the
--     Owner — the application now protects the Owner explicitly).
--  9. leave_workspace_atomic: 065 silently dropped the MANAGE_ROLES sole-holder
--     guard (034) and the trial-creator guard (038) — restored — and leaving
--     now also archives the leaver's project assignments (like a deactivation)
--     and revokes the pending invites they sent.
-- 10. security audit helper that writes to EVERY workspace the person belongs
--     to; password + email-change audit rows written per workspace.
-- ============================================================


-- ── 0. shared helpers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_active_workspace(p_user uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ws uuid;
BEGIN
  SELECT m.workspace_id INTO v_ws
  FROM public.users u
  JOIN public.workspace_members m ON m.user_id = u.id AND m.workspace_id = u.active_workspace_id AND m.status = 'active'
  JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
  WHERE u.id = p_user;
  IF v_ws IS NULL THEN
    SELECT m.workspace_id INTO v_ws
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
    WHERE m.user_id = p_user AND m.status = 'active'
    ORDER BY (w.onboarding_completed_at IS NULL) ASC, m.created_at ASC LIMIT 1;
  END IF;
  RETURN v_ws;
END;
$$;

-- Writes one security audit row for the person: into EVERY workspace they are an
-- active member of (p_all) or only their active one. A security event about a
-- person concerns every workspace that grants them access.
CREATE OR REPLACE FUNCTION public.security_audit_insert(
  p_user uuid, p_event text, p_metadata jsonb, p_all boolean DEFAULT true, p_ip text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_email text; v_name text; v_ws uuid;
BEGIN
  SELECT u.email, u.name INTO v_email, v_name FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_all THEN
    INSERT INTO public.audit_log (workspace_id, actor_id, actor_email, actor_name, event_type, entity_type, entity_id, entity_name, metadata, ip_address)
    SELECT m.workspace_id, p_user, COALESCE(v_email, ''), COALESCE(NULLIF(v_name, ''), v_email, ''), p_event, 'user', p_user, v_name, COALESCE(p_metadata, '{}'::jsonb), p_ip
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
    WHERE m.user_id = p_user AND m.status = 'active';
  ELSE
    v_ws := public.audit_active_workspace(p_user);
    IF v_ws IS NOT NULL THEN
      INSERT INTO public.audit_log (workspace_id, actor_id, actor_email, actor_name, event_type, entity_type, entity_id, entity_name, metadata, ip_address)
      VALUES (v_ws, p_user, COALESCE(v_email, ''), COALESCE(NULLIF(v_name, ''), v_email, ''), p_event, 'user', p_user, v_name, COALESCE(p_metadata, '{}'::jsonb), p_ip);
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'security_audit_insert failed for % (%): %', p_user, p_event, SQLERRM;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_active_workspace(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.security_audit_insert(uuid, text, jsonb, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_active_workspace(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.security_audit_insert(uuid, text, jsonb, boolean, text) TO service_role;


-- ── 1. atomic attempt ledger ───────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_attempts_kind_check' AND conrelid = 'public.auth_attempts'::regclass) THEN
    ALTER TABLE public.auth_attempts DROP CONSTRAINT auth_attempts_kind_check;
  END IF;
  ALTER TABLE public.auth_attempts ADD CONSTRAINT auth_attempts_kind_check
    CHECK (kind IN ('mfa_verify', 'mfa_recover', 'password_verify', 'mfa_verify_hook', 'password_login_hook'));
END $$;

-- Reserve-then-verify. The reservation row is inserted under a per-(user,kind)
-- advisory lock BEFORE the caller checks the credential, and counts as a failure
-- until it is released (non-strike error) or the failures are cleared (success).
-- At most p_max reservations can ever be outstanding in a window, however many
-- requests arrive in parallel.
CREATE OR REPLACE FUNCTION public.auth_attempt_begin(p_user uuid, p_kind text, p_max int, p_window_seconds int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_since  timestamptz := now() - make_interval(secs => p_window_seconds);
  v_count  int;
  v_id     uuid;
  v_anchor timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('auth_attempt:' || p_user::text || ':' || p_kind, 0));

  SELECT count(*) INTO v_count FROM public.auth_attempts
  WHERE user_id = p_user AND kind = p_kind AND succeeded = false AND created_at >= v_since;

  IF v_count >= p_max THEN
    -- Locked until the OLDEST of the latest p_max failures leaves the window.
    SELECT created_at INTO v_anchor FROM public.auth_attempts
    WHERE user_id = p_user AND kind = p_kind AND succeeded = false AND created_at >= v_since
    ORDER BY created_at DESC OFFSET (p_max - 1) LIMIT 1;
    RETURN jsonb_build_object('allowed', false, 'attempt_id', NULL, 'failures', v_count,
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM (v_anchor + make_interval(secs => p_window_seconds) - now())))::int));
  END IF;

  INSERT INTO public.auth_attempts (user_id, kind, succeeded) VALUES (p_user, p_kind, false) RETURNING id INTO v_id;
  RETURN jsonb_build_object('allowed', true, 'attempt_id', v_id, 'failures', v_count + 1, 'retry_after_seconds', 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_attempt_release(p_attempt uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM public.auth_attempts WHERE id = p_attempt;
$$;

REVOKE ALL ON FUNCTION public.auth_attempt_begin(uuid, text, int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_attempt_release(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_attempt_begin(uuid, text, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_attempt_release(uuid) TO service_role;


-- ── 2. Supabase Auth hooks (enable in Dashboard -> Auth -> Hooks) ──────────
-- MFA Verification Attempt hook: event = { factor_id, factor_type, user_id, valid }.
CREATE OR REPLACE FUNCTION public.hook_mfa_verification_attempt(event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_max CONSTANT int := 5;
  c_win CONSTANT int := 300;
  v_user  uuid;
  v_valid boolean := COALESCE((event ->> 'valid')::boolean, false);
  v_count int;
  v_anchor timestamptz;
BEGIN
  BEGIN v_user := (event ->> 'user_id')::uuid; EXCEPTION WHEN OTHERS THEN v_user := NULL; END;
  IF v_user IS NULL THEN RETURN jsonb_build_object('decision', 'continue'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('auth_attempt:' || v_user::text || ':mfa_verify_hook', 0));

  SELECT count(*) INTO v_count FROM public.auth_attempts
  WHERE user_id = v_user AND kind = 'mfa_verify_hook' AND succeeded = false AND created_at >= now() - make_interval(secs => c_win);

  IF v_count >= c_max THEN
    SELECT created_at INTO v_anchor FROM public.auth_attempts
    WHERE user_id = v_user AND kind = 'mfa_verify_hook' AND succeeded = false AND created_at >= now() - make_interval(secs => c_win)
    ORDER BY created_at DESC OFFSET (c_max - 1) LIMIT 1;
    RETURN jsonb_build_object('decision', 'reject',
      'message', 'Too many incorrect attempts. Try again in ' ||
        GREATEST(1, ceil(extract(epoch FROM (v_anchor + make_interval(secs => c_win) - now())) / 60.0)::int) || ' minute(s).');
  END IF;

  IF v_valid THEN
    DELETE FROM public.auth_attempts WHERE user_id = v_user AND kind = 'mfa_verify_hook' AND succeeded = false;
  ELSE
    INSERT INTO public.auth_attempts (user_id, kind, succeeded) VALUES (v_user, 'mfa_verify_hook', false);
    IF v_count + 1 >= c_max THEN
      PERFORM public.security_audit_insert(v_user, 'security.mfa_locked',
        jsonb_build_object('source', 'auth_hook', 'failures_in_window', v_count + 1, 'window_seconds', c_win), false);
    END IF;
  END IF;
  RETURN jsonb_build_object('decision', 'continue');
END;
$$;

-- Password Verification Attempt hook (Supabase Team or Enterprise plan):
-- event = { user_id, valid }. Records failed sign-ins in the audit trail and
-- locks password sign-in for an account after 10 failures in 10 minutes.
CREATE OR REPLACE FUNCTION public.hook_password_verification_attempt(event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_max CONSTANT int := 10;
  c_win CONSTANT int := 600;
  v_user  uuid;
  v_valid boolean := COALESCE((event ->> 'valid')::boolean, false);
  v_count int;
BEGIN
  BEGIN v_user := (event ->> 'user_id')::uuid; EXCEPTION WHEN OTHERS THEN v_user := NULL; END;
  IF v_user IS NULL THEN RETURN jsonb_build_object('decision', 'continue'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('auth_attempt:' || v_user::text || ':password_login_hook', 0));

  SELECT count(*) INTO v_count FROM public.auth_attempts
  WHERE user_id = v_user AND kind = 'password_login_hook' AND succeeded = false AND created_at >= now() - make_interval(secs => c_win);

  IF v_count >= c_max THEN
    RETURN jsonb_build_object('decision', 'reject',
      'message', 'Too many failed sign-in attempts. Try again in a few minutes, or reset your password.');
  END IF;

  IF v_valid THEN
    DELETE FROM public.auth_attempts WHERE user_id = v_user AND kind = 'password_login_hook' AND succeeded = false;
  ELSE
    INSERT INTO public.auth_attempts (user_id, kind, succeeded) VALUES (v_user, 'password_login_hook', false);
    PERFORM public.security_audit_insert(v_user, 'security.login_failed',
      jsonb_build_object('source', 'auth_hook', 'failures_in_window', v_count + 1, 'locked', v_count + 1 >= c_max), false);
  END IF;
  RETURN jsonb_build_object('decision', 'continue');
END;
$$;

REVOKE ALL ON FUNCTION public.hook_mfa_verification_attempt(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hook_password_verification_attempt(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hook_mfa_verification_attempt(jsonb) TO supabase_auth_admin, service_role;
GRANT EXECUTE ON FUNCTION public.hook_password_verification_attempt(jsonb) TO supabase_auth_admin, service_role;
GRANT ALL ON public.auth_attempts TO supabase_auth_admin;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;


-- ── 3. server-side sign-in audit (auth.sessions) ───────────────────────────
CREATE OR REPLACE FUNCTION public.audit_auth_session_login()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row      jsonb := to_jsonb(NEW);
  v_provider text;
  v_method   text;
  v_meta     jsonb;
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      -- A sign-in that still owes a second factor has not succeeded yet: it is
      -- recorded when the session is upgraded to aal2 (UPDATE branch below).
      IF EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = NEW.user_id AND f.status = 'verified') THEN
        RETURN NEW;
      END IF;
    ELSE
      IF COALESCE(v_row ->> 'aal', '') <> 'aal2' OR COALESCE(to_jsonb(OLD) ->> 'aal', '') = 'aal2' THEN
        RETURN NEW;
      END IF;
    END IF;

    SELECT i.provider INTO v_provider FROM auth.identities i WHERE i.user_id = NEW.user_id ORDER BY i.last_sign_in_at DESC NULLS LAST LIMIT 1;
    v_method := CASE WHEN v_provider = 'google' THEN 'google' ELSE 'password' END;

    v_meta := jsonb_build_object('source', 'db_trigger', 'method', v_method, 'session_id', NEW.id,
                                 'user_agent', LEFT(COALESCE(v_row ->> 'user_agent', ''), 200));
    IF TG_OP = 'UPDATE' THEN v_meta := v_meta || jsonb_build_object('mfa', 'totp'); END IF;

    PERFORM public.security_audit_insert(NEW.user_id, 'security.login_succeeded', v_meta, false, v_row ->> 'ip');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_auth_session_login failed for %: %', NEW.user_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_auth_session_login() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS on_auth_session_created ON auth.sessions;
  CREATE TRIGGER on_auth_session_created
    AFTER INSERT ON auth.sessions
    FOR EACH ROW EXECUTE FUNCTION public.audit_auth_session_login();
  DROP TRIGGER IF EXISTS on_auth_session_aal_upgraded ON auth.sessions;
  CREATE TRIGGER on_auth_session_aal_upgraded
    AFTER UPDATE OF aal ON auth.sessions
    FOR EACH ROW WHEN (NEW.aal IS DISTINCT FROM OLD.aal)
    EXECUTE FUNCTION public.audit_auth_session_login();
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not create the auth.sessions sign-in audit triggers (%). The app-side login-event fallback stays active; create them with a role that owns auth.sessions.', SQLERRM;
END $$;


-- ── 4. session management + helpers ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_user_sessions(p_user uuid)
RETURNS TABLE (id uuid, created_at timestamptz, refreshed_at timestamptz, user_agent text, ip text, aal text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.created_at,
         COALESCE((to_jsonb(s) ->> 'refreshed_at')::timestamptz, (to_jsonb(s) ->> 'updated_at')::timestamptz, s.created_at),
         to_jsonb(s) ->> 'user_agent', to_jsonb(s) ->> 'ip', to_jsonb(s) ->> 'aal'
  FROM auth.sessions s
  WHERE s.user_id = p_user
    AND (to_jsonb(s) ->> 'not_after' IS NULL OR (to_jsonb(s) ->> 'not_after')::timestamptz > now())
  ORDER BY 3 DESC;
$$;

CREATE OR REPLACE FUNCTION public.revoke_user_session(p_user uuid, p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  DELETE FROM auth.sessions WHERE id = p_session AND user_id = p_user;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user uuid, p_except uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  DELETE FROM auth.sessions WHERE user_id = p_user AND (p_except IS NULL OR id <> p_except);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.user_has_password(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT COALESCE(u.encrypted_password, '') <> '' FROM auth.users u WHERE u.id = p_user), false);
$$;

REVOKE ALL ON FUNCTION public.list_user_sessions(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_user_session(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.user_has_password(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_user_sessions(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_user_session(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.user_has_password(uuid) TO service_role;

-- Step-up (recent re-authentication) grants, tied to one session.
CREATE TABLE IF NOT EXISTS public.step_up_grants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  session_id text NOT NULL,
  method     text NOT NULL CHECK (method IN ('password', 'totp')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS step_up_grants_lookup ON public.step_up_grants (user_id, session_id, expires_at DESC);
ALTER TABLE public.step_up_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.step_up_grants FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.step_up_grants TO service_role;

-- First time the APP sees each session (drives new-device sign-in alerts).
CREATE TABLE IF NOT EXISTS public.session_seen (
  session_id    text PRIMARY KEY,
  user_id       uuid NOT NULL,
  ip            text,
  user_agent    text,
  device_key    text,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_seen_user ON public.session_seen (user_id, first_seen_at DESC);
ALTER TABLE public.session_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_seen FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.session_seen TO service_role;


-- ── 5. atomic backup-code issue ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.issue_backup_codes(p_user uuid, p_hashes text[])
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  IF p_hashes IS NULL OR array_length(p_hashes, 1) IS NULL THEN RAISE EXCEPTION 'no_hashes'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('backup_codes:' || p_user::text, 0));
  UPDATE public.user_mfa_backup_codes SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  INSERT INTO public.user_mfa_backup_codes (user_id, code_hash) SELECT p_user, h FROM unnest(p_hashes) AS h;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.issue_backup_codes(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_backup_codes(uuid, text[]) TO service_role;


-- ── 6. public.users.name ───────────────────────────────────────────────────
UPDATE public.users
SET name = COALESCE(LEFT(TRIM(regexp_replace(regexp_replace(name, '[\r\n\x00-\x1F\x7F]', ' ', 'g'), '\s+', ' ', 'g')), 120), '')
WHERE char_length(name) > 120 OR name ~ '[\r\n\x00-\x1F\x7F]';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_name_clean' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_name_clean
      CHECK (char_length(name) <= 120 AND name !~ '[\r\n\x00-\x1F\x7F]') NOT VALID;
    ALTER TABLE public.users VALIDATE CONSTRAINT users_name_clean;
  END IF;
END $$;

-- No session-bound code writes public.users (tests/rls-contract.test.ts asserts it):
-- every rename goes through /api/workspace/profile with the service role. Close
-- the direct PostgREST path that skipped every sanitiser.
REVOKE UPDATE (name, updated_at) ON public.users FROM authenticated;
DROP POLICY IF EXISTS users_own ON public.users;
DROP POLICY IF EXISTS users_select_own ON public.users;
CREATE POLICY users_select_own ON public.users FOR SELECT USING (auth.uid() = id);


-- ── 7. grant hygiene ───────────────────────────────────────────────────────
REVOKE ALL ON public.cron_heartbeats FROM PUBLIC, anon, authenticated;

-- anon has no legitimate table access at all; authenticated only the three
-- reviewed exceptions. Sweep every public table/sequence so drift can't persist.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', r.relname);
    IF r.relname NOT IN ('users', 'workspaces', 'user_mfa_backup_codes') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', r.relname);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not adjust default privileges (%). Re-run as the role that owns the public schema defaults.', SQLERRM;
END $$;

-- Buckets were created by hand (README §1.2) and had no bucket-level limits. A
-- public bucket with an allowlist stays safe even if a permissive storage policy
-- is ever added by mistake.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('logos', 'logos', true, 2097152, ARRAY['image/png', 'image/jpeg'])
ON CONFLICT (id) DO UPDATE SET file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('flag-evidence', 'flag-evidence', false, 10485760, ARRAY[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'message/rfc822', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
ON CONFLICT (id) DO UPDATE SET file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ── 8. retire the stale EXPORT_DATA permission key ─────────────────────────
UPDATE public.roles SET permissions = permissions - 'EXPORT_DATA' WHERE permissions ? 'EXPORT_DATA';
UPDATE public.workspace_members SET permission_overrides = permission_overrides - 'EXPORT_DATA' WHERE permission_overrides ? 'EXPORT_DATA';
UPDATE public.workspace_members SET effective_permissions = effective_permissions - 'EXPORT_DATA' WHERE effective_permissions ? 'EXPORT_DATA';

CREATE OR REPLACE FUNCTION public.create_workspace_atomic(p_workspace_id uuid, p_user_id uuid, p_name text, p_slug text, p_agency_name text, p_industry text, p_currency text, p_timezone text, p_jwt_secret text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  owner_role_id uuid;
  all_permissions jsonb;
  existing_trial_used_at timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'p_user_id must match the calling user';
  END IF;

  -- Lock the user row so two concurrent create calls for the same
  -- never-yet-trialed user can't both read trial_used_at as NULL and
  -- both slip through before either write lands.
  SELECT trial_used_at INTO existing_trial_used_at
  FROM public.users WHERE id = p_user_id FOR UPDATE;

  IF existing_trial_used_at IS NOT NULL
     AND existing_trial_used_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'TRIAL_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- FIX (migration 057): VIEW_PORTFOLIO added (26th permission) -- see this file's header.
  all_permissions := '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":true,
    "VIEW_CLIENT_DATA":true,"CREATE_PROJECTS":true,"EDIT_SOW":true,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":true,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":true,
    "GRANT_EXCEPTIONS":true,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":true,"MANAGE_ROLES":true,
    "MANAGE_BILLING":true,"DELETE_PROJECTS":true,
    "VIEW_AUDIT_LOG":true,"MANAGE_WORKSPACE_SETTINGS":true,"SEND_INVOICES":true,
    "APPROVE_DOCUMENTS":true,"VIEW_PORTFOLIO":true
  }'::jsonb;

  -- jwt_secret no longer written here — see workspace_secrets insert below.
  INSERT INTO public.workspaces (
    id, name, slug, agency_name, industry, currency, timezone,
    plan_tier, trial_ends_at, created_by
  ) VALUES (
    p_workspace_id, p_name, p_slug, p_agency_name, p_industry,
    p_currency, p_timezone, 'trial', now() + interval '14 days', p_user_id
  );

  INSERT INTO public.workspace_secrets (workspace_id, jwt_secret)
  VALUES (p_workspace_id, p_jwt_secret);

  INSERT INTO public.roles (id, workspace_id, name, permissions, is_default, created_by)
  VALUES (gen_random_uuid(), p_workspace_id, 'Owner', all_permissions, false, p_user_id)
  RETURNING id INTO owner_role_id;

  INSERT INTO public.roles (workspace_id, name, permissions, is_default, created_by) VALUES
  (p_workspace_id, 'Account Manager', '{
    "VIEW_OWN_PROJECTS":false,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":true,
    "VIEW_CLIENT_DATA":true,"CREATE_PROJECTS":true,"EDIT_SOW":true,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":true,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":true,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":true,
    "APPROVE_DOCUMENTS":false,"VIEW_PORTFOLIO":true
  }'::jsonb, true, p_user_id),
  (p_workspace_id, 'Designer', '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":false,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":false,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":false,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":false,
    "APPROVE_DOCUMENTS":false,"VIEW_PORTFOLIO":false
  }'::jsonb, false, p_user_id),
  (p_workspace_id, 'Project Coordinator', '{
    "VIEW_OWN_PROJECTS":false,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":false,
    "APPROVE_DOCUMENTS":false,"VIEW_PORTFOLIO":false
  }'::jsonb, false, p_user_id);

  INSERT INTO public.workspace_members (
    workspace_id, user_id, role_id, effective_permissions,
    status, joined_at, invited_by
  ) VALUES (
    p_workspace_id, p_user_id, owner_role_id, all_permissions,
    'active', now(), NULL
  );

  UPDATE public.users
  SET active_workspace_id = p_workspace_id,
      trial_used_at = COALESCE(trial_used_at, now())
  WHERE id = p_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_workspace_atomic(uuid, uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace_atomic(uuid, uuid, text, text, text, text, text, text, text) TO service_role;


-- ── 9. leave_workspace_atomic ──────────────────────────────────────────────
-- 065 rebuilt this from the 027 shape and lost: the sole MANAGE_ROLES holder
-- guard (034) and the trial-creator guard (038). Both restored, together with
-- 065's completed-onboarding fallback, plus cleanup of what the leaver leaves
-- behind: their project assignments (archived, like a deactivation) and the pending invites THEY sent (an
-- invite outlives its sender's authority to grant the role otherwise).
CREATE OR REPLACE FUNCTION public.leave_workspace_atomic(p_workspace_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member_id             uuid;
  v_leaver_settings_admin boolean;
  v_leaver_roles_admin    boolean;
  v_active_count          int;
  v_other_settings_admins int;
  v_other_roles_admins    int;
  v_current_active_ws     uuid;
  v_fallback_ws           uuid;
  v_ws_created_by         uuid;
  v_ws_plan_tier          text;
BEGIN
  PERFORM 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active'
    FOR UPDATE;

  SELECT id,
         (effective_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean,
         (effective_permissions->>'MANAGE_ROLES')::boolean
    INTO v_member_id, v_leaver_settings_admin, v_leaver_roles_admin
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active';

  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'not_a_member';
  END IF;

  SELECT count(*) INTO v_active_count
  FROM public.workspace_members WHERE workspace_id = p_workspace_id AND status = 'active';

  IF v_active_count <= 1 THEN
    RAISE EXCEPTION 'last_member';
  END IF;

  IF COALESCE(v_leaver_settings_admin, false) THEN
    SELECT count(*) INTO v_other_settings_admins
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active' AND id <> v_member_id
      AND (effective_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean IS TRUE;
    IF v_other_settings_admins = 0 THEN
      RAISE EXCEPTION 'sole_admin';
    END IF;
  END IF;

  IF COALESCE(v_leaver_roles_admin, false) THEN
    SELECT count(*) INTO v_other_roles_admins
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active' AND id <> v_member_id
      AND (effective_permissions->>'MANAGE_ROLES')::boolean IS TRUE;
    IF v_other_roles_admins = 0 THEN
      RAISE EXCEPTION 'sole_roles_admin';
    END IF;
  END IF;

  SELECT created_by, plan_tier INTO v_ws_created_by, v_ws_plan_tier
  FROM public.workspaces WHERE id = p_workspace_id;

  IF v_ws_created_by = p_user_id AND v_ws_plan_tier = 'trial' THEN
    RAISE EXCEPTION 'trial_creator';
  END IF;

  UPDATE public.workspace_members
  SET status = 'deactivated', deactivated_at = now()
  WHERE id = v_member_id;

  -- Same as DELETE /api/team/[id]: archive (not delete) the assignments so a later
  -- reactivation can restore them (migration 067).
  PERFORM public.archive_member_projects(v_member_id);

  DELETE FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND invited_by = p_user_id AND status IN ('invited', 'expired') AND user_id IS DISTINCT FROM p_user_id;

  SELECT active_workspace_id INTO v_current_active_ws FROM public.users WHERE id = p_user_id;
  IF v_current_active_ws = p_workspace_id THEN
    SELECT wm.workspace_id INTO v_fallback_ws
    FROM public.workspace_members wm
    JOIN public.workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = p_user_id AND wm.status = 'active' AND w.deleted_at IS NULL
    ORDER BY (w.onboarding_completed_at IS NULL) ASC, wm.created_at ASC
    LIMIT 1;

    UPDATE public.users SET active_workspace_id = v_fallback_ws WHERE id = p_user_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.leave_workspace_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_workspace_atomic(uuid, uuid) TO service_role;


-- ── 10. password / email-change audit (every workspace) ───────────────────
-- A password change concerns every workspace the person belongs to (064 wrote
-- the audit row to one).
CREATE OR REPLACE FUNCTION public.audit_auth_password_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_first boolean;
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.id AND u.deleted_at IS NULL) THEN
      RETURN NEW;
    END IF;
    v_first := (OLD.encrypted_password IS NULL OR OLD.encrypted_password = '');
    PERFORM public.security_audit_insert(NEW.id, 'security.password_changed',
      jsonb_build_object('source', 'db_trigger', 'first_password', v_first), true);

    INSERT INTO public.notifications (workspace_id, recipient_id, type, title, body)
    SELECT m.workspace_id, NEW.id, 'security', 'Your password was changed',
           'If this wasn''t you, sign out everywhere from Settings and reset your password immediately.'
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
    WHERE m.user_id = NEW.id AND m.status = 'active';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_auth_password_change failed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_public_user_email()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.email IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email THEN
    BEGIN
      UPDATE public.users SET email = NEW.email, updated_at = now()
      WHERE id = NEW.id AND deleted_at IS NULL;
      PERFORM public.security_audit_insert(NEW.id, 'security.email_changed',
        jsonb_build_object('source', 'db_trigger', 'old_email', OLD.email, 'new_email', NEW.email), true);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'sync_public_user_email failed for %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;
