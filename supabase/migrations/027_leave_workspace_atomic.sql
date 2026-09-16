-- ============================================================
-- ScopeGov — Migration 027: close workspace/leave's TOCTOU race
--
-- app/api/workspace/leave/route.ts's two guards ("don't let the last
-- active member leave" and "don't let the sole MANAGE_WORKSPACE_SETTINGS
-- holder leave while only non-admin roles remain") both read the current
-- active-member set, then write, as two separate steps with no lock in
-- between. Two members leaving in the same instant can each read the
-- pre-leave state, both pass their own guard (each sees the OTHER as the
-- "one member"/"one admin" who'll remain), and both leave — landing the
-- workspace at zero members, or headless with no one left who can invite,
-- edit roles, or even delete the workspace to start over.
--
-- Fixed the same way this schema already fixes atomic multi-step writes
-- elsewhere (create_workspace_atomic, purge_project/purge_workspace):
-- move the whole check-and-write into one SECURITY DEFINER function that
-- takes `FOR UPDATE` row locks on every active membership for the
-- workspace up front, serializing concurrent leave calls for the same
-- workspace so the second caller's guard check runs against the FIRST
-- caller's already-applied state, not a stale pre-leave snapshot.
-- ============================================================

CREATE OR REPLACE FUNCTION public.leave_workspace_atomic(p_workspace_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member_id             uuid;
  v_leaver_admin_capable  boolean;
  v_active_count          int;
  v_other_admin_count     int;
  v_current_active_ws     uuid;
  v_fallback_ws           uuid;
BEGIN
  -- Lock every active membership row for this workspace before reading
  -- anything, so a concurrent call for the SAME workspace blocks here
  -- until this transaction commits or rolls back — no two leaves for the
  -- same workspace can ever evaluate their guard against the same
  -- pre-leave snapshot.
  PERFORM 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active'
    FOR UPDATE;

  SELECT id, (effective_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean
    INTO v_member_id, v_leaver_admin_capable
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

  IF COALESCE(v_leaver_admin_capable, false) THEN
    SELECT count(*) INTO v_other_admin_count
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active' AND id <> v_member_id
      AND (effective_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean IS TRUE;

    IF v_other_admin_count = 0 THEN
      RAISE EXCEPTION 'sole_admin';
    END IF;
  END IF;

  UPDATE public.workspace_members
  SET status = 'deactivated', deactivated_at = now()
  WHERE id = v_member_id;

  -- If this was the leaving user's active workspace, reassign it to
  -- another workspace they still belong to (same fallback the route
  -- already did — kept here so the whole operation is one transaction).
  SELECT active_workspace_id INTO v_current_active_ws FROM public.users WHERE id = p_user_id;
  IF v_current_active_ws = p_workspace_id THEN
    SELECT workspace_id INTO v_fallback_ws
    FROM public.workspace_members
    WHERE user_id = p_user_id AND status = 'active'
    ORDER BY created_at ASC LIMIT 1;

    UPDATE public.users SET active_workspace_id = v_fallback_ws WHERE id = p_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.leave_workspace_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_workspace_atomic(uuid, uuid) TO service_role;
