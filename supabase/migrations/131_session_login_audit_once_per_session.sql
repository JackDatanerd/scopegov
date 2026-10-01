-- ============================================================
-- ScopeGov — Migration 131
-- Auth + MFA independent pass 7: one `security.login_succeeded` row per session.
-- Idempotent (CREATE OR REPLACE). Run AFTER 130.
--
-- audit_auth_session_login() (068, 115) records a sign-in in two places:
--   INSERT on auth.sessions  — when the person has NO verified second factor;
--   UPDATE OF aal (-> aal2)  — when a session that owed a second factor passes it.
-- First-time MFA enrolment also moves the session aal1 -> aal2 (the enrolment itself
-- is a TOTP verification), so the UPDATE branch fired for a session whose sign-in the
-- INSERT branch had ALREADY recorded: every first enrolment put a second "login
-- succeeded" row (method + `mfa: totp`) into every audit log for a login that never
-- happened.
--
-- This is the same function as 115 with ONE addition to the UPDATE branch: it stands
-- down when a `security.login_succeeded` row for THIS session (metadata.session_id,
-- written by the INSERT branch) already exists. A session whose INSERT was skipped
-- because a factor already existed — an ordinary MFA sign-in, or a backup-code recovery
-- followed by re-enrolment — has no such row yet, so it is still recorded exactly once,
-- as before.
-- ============================================================

CREATE OR REPLACE FUNCTION public.audit_auth_session_login()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row      jsonb := to_jsonb(NEW);
  v_provider text;
  v_method   text;
  v_meta     jsonb;
BEGIN
  BEGIN
    -- A password re-verification made by the app itself, not a person signing in.
    IF COALESCE(v_row ->> 'user_agent', '') LIKE 'ScopeGov-CredentialCheck/%' THEN
      RETURN NEW;
    END IF;

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
      -- This session's sign-in was already recorded when it was created (the person had
      -- no second factor then), so this aal2 upgrade is a first-time ENROLMENT, not a
      -- sign-in. One row per session.
      IF EXISTS (
        SELECT 1 FROM public.audit_log a
        WHERE a.actor_id = NEW.user_id
          AND a.event_type = 'security.login_succeeded'
          AND a.metadata ->> 'session_id' = NEW.id::text
      ) THEN
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
