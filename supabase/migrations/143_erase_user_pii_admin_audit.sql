-- 143_erase_user_pii_admin_audit.sql
--
-- Admin panel independent audit, round 2 (B3): erase_user_pii() scrubbed the customer-facing audit_log, notifications and
-- identities but never platform_admin_audit_log, whose target_label holds the person's e-mail on every user.viewed /
-- user.suspended / user.restored / user.mfa_reset / user.sessions_revoked row (and users.searched rows hold whatever was
-- typed, usually an e-mail). After the 30-day erasure the address therefore survived there for good.
--
-- The staff-side columns (admin_*, ip_address) are the platform's own record and are left alone. Idempotent.
-- Body is migration 121's, plus the platform_admin_audit_log block.

CREATE OR REPLACE FUNCTION public.erase_user_pii(p_user_id uuid, p_email text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_audit       integer := 0;
  v_target      integer := 0;
  v_notes       integer := 0;
  v_identities  integer := 0;
  v_invited     integer := 0;
  v_admin_log   integer := 0;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'erase_user_pii: p_user_id is required'; END IF;

  PERFORM set_config('app.audit_purge', 'on', true);
  BEGIN
    UPDATE public.audit_log
       SET actor_email = 'deleted-' || p_user_id::text || '@deleted.scopegov.app',
           actor_name  = '[Deleted user]',
           ip_address  = NULL
     WHERE actor_id = p_user_id
       AND (actor_name <> '[Deleted user]' OR ip_address IS NOT NULL
            OR actor_email <> 'deleted-' || p_user_id::text || '@deleted.scopegov.app');
    GET DIAGNOSTICS v_audit = ROW_COUNT;

    IF p_email IS NOT NULL AND length(btrim(p_email)) > 3 THEN
      UPDATE public.audit_log
         SET entity_name = '[Deleted user]'
       WHERE lower(entity_name) = lower(btrim(p_email))
         AND workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = p_user_id);
      GET DIAGNOSTICS v_target = ROW_COUNT;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.audit_purge', 'off', true);
    RAISE;
  END;
  PERFORM set_config('app.audit_purge', 'off', true);

  -- Platform admin audit log: rows ABOUT this person, plus searches that typed their old e-mail.
  UPDATE public.platform_admin_audit_log
     SET target_label = '[Deleted user]'
   WHERE target_label IS DISTINCT FROM '[Deleted user]'
     AND ( (target_type = 'user' AND target_id = p_user_id)
        OR (p_email IS NOT NULL AND length(btrim(p_email)) > 3 AND lower(btrim(target_label)) = lower(btrim(p_email))) );
  GET DIAGNOSTICS v_admin_log = ROW_COUNT;

  UPDATE public.workspace_members
     SET invited_email = NULL
   WHERE user_id = p_user_id AND invited_email IS NOT NULL;
  GET DIAGNOSTICS v_invited = ROW_COUNT;

  DELETE FROM public.notifications WHERE recipient_id = p_user_id;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  DELETE FROM auth.identities WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_identities = ROW_COUNT;

  RETURN jsonb_build_object(
    'audit_actor_rows', v_audit, 'audit_target_rows', v_target,
    'notifications', v_notes, 'identities', v_identities,
    'invited_emails', v_invited, 'admin_audit_rows', v_admin_log
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erase_user_pii(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_user_pii(uuid, text) TO service_role;

-- One-time backfill: accounts already anonymized (their e-mail is now deleted-<id>@deleted.scopegov.app, so match by id).
UPDATE public.platform_admin_audit_log l
   SET target_label = '[Deleted user]'
  FROM public.users u
 WHERE l.target_type = 'user' AND l.target_id = u.id
   AND u.email LIKE 'deleted-%@deleted.scopegov.app'
   AND l.target_label IS DISTINCT FROM '[Deleted user]';
