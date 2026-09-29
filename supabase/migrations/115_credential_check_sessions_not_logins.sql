-- ============================================================
-- ScopeGov — Migration 115
-- Auth + MFA fresh audit: password re-verification sessions are not sign-ins.
-- Idempotent (CREATE OR REPLACE). Run AFTER 114.
--
-- /api/auth/change-password and /api/auth/step-up confirm the current password by
-- calling signInWithPassword() on a stateless client (lib/supabase/server.ts
-- createStatelessAuthClient), which creates a real auth.sessions row that is
-- revoked moments later. audit_auth_session_login() (068) recorded every one as a
-- `security.login_succeeded` audit row — a login that never happened, from the
-- server's egress IP, indistinguishable from a real one.
--
-- That client now sends `User-Agent: ScopeGov-CredentialCheck/1`; GoTrue stores it in
-- auth.sessions.user_agent. This is the same function as 068 with ONE addition: an
-- early return for sessions carrying that marker. If GoTrue did not store the
-- header the behaviour is exactly what it was before (nothing is skipped).
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
