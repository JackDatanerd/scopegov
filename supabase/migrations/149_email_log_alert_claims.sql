-- ============================================================
-- ScopeGov — Migration 149: per-email bounce-alert claims
--
-- The Resend webhook raises one in-app alert per (failure kind, address) for each tracked email. A redelivered or
-- concurrent event must not raise it twice, but the old dedupe looked for a notification with the same type/title
-- created after the email was logged — which could also match an alert for a DIFFERENT email to the same address,
-- swallowing a legitimate second alert. The claim now lives on the email_log row itself.
--
-- Idempotent. Service-role only (email_log is already revoked from every other role).
-- ============================================================

ALTER TABLE public.email_log
  ADD COLUMN IF NOT EXISTS alerted_keys text[] NOT NULL DEFAULT '{}';

-- Atomically claim a key for this email. TRUE = this caller claimed it (and must raise the alert);
-- FALSE = it was already claimed.
CREATE OR REPLACE FUNCTION public.claim_email_alert(p_email_log_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE public.email_log
     SET alerted_keys = array_append(alerted_keys, p_key)
   WHERE id = p_email_log_id
     AND NOT (p_key = ANY(alerted_keys))
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- Give the claim back when the alert could not be written, so the webhook retry raises it.
CREATE OR REPLACE FUNCTION public.release_email_alert(p_email_log_id uuid, p_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.email_log SET alerted_keys = array_remove(alerted_keys, p_key) WHERE id = p_email_log_id;
$$;

REVOKE ALL ON FUNCTION public.claim_email_alert(uuid, text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_email_alert(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_email_alert(uuid, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.release_email_alert(uuid, text) TO service_role;
