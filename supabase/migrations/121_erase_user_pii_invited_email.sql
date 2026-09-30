-- Cron section 17 (independent pass) — account erasure left the person's real email behind.
--
-- erase_user_pii() (migration 075) scrubs audit_log, notifications and auth.identities, and invite-cleanup then
-- anonymizes public.users. It never touched workspace_members.invited_email, which the invite flow fills with the
-- address the person was invited at and which the accept route deliberately leaves in place after they join
-- (status flips to 'active', user_id is set, invited_email stays). So after the day-30 erasure every workspace the
-- person joined by invite still carried their real address on their deactivated member row:
--   * it is selected for admins on the team page for deactivated members (not rendered, but in the payload), and
--   * /api/team/invite matches existing rows by invited_email, so re-inviting the same address hit the erased,
--     banned account's row ("Reactivate it instead") and the new person could never be invited back.
--
-- Fix: erase_user_pii also NULLs invited_email on every member row that belongs to the erased user. The pending-invite
-- unique index (status = 'invited' AND invited_email IS NOT NULL) is unaffected: only rows that already have a user_id
-- (i.e. were accepted) are touched. The function stays idempotent and service-role only.
--
-- Backfill: users already erased before this migration (email = 'deleted-<uuid>@deleted.scopegov.app') get the same
-- treatment once, here.

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

    -- Events ABOUT the person (an invite or role change names them as the entity) — matched on their old
    -- login email, and only within workspaces they were a member of, so this never scans the whole table.
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

  -- The address they were invited at survives on every member row they accepted (see header).
  UPDATE public.workspace_members
     SET invited_email = NULL
   WHERE user_id = p_user_id AND invited_email IS NOT NULL;
  GET DIAGNOSTICS v_invited = ROW_COUNT;

  -- Their own bell: nobody else can see it, and the titles/bodies routinely carry names.
  DELETE FROM public.notifications WHERE recipient_id = p_user_id;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  -- OAuth identities hold the provider's copy of the email / name (identity_data).
  DELETE FROM auth.identities WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_identities = ROW_COUNT;

  RETURN jsonb_build_object(
    'audit_actor_rows', v_audit, 'audit_target_rows', v_target,
    'notifications', v_notes, 'identities', v_identities,
    'invited_emails', v_invited
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erase_user_pii(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_user_pii(uuid, text) TO service_role;

-- One-time backfill for accounts already anonymized.
UPDATE public.workspace_members wm
   SET invited_email = NULL
  FROM public.users u
 WHERE wm.user_id = u.id
   AND wm.invited_email IS NOT NULL
   AND u.email LIKE 'deleted-%@deleted.scopegov.app';
