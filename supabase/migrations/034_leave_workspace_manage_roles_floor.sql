-- ============================================================
-- ScopeGov — Migration 034: leave_workspace_atomic's admin-floor
-- check missed MANAGE_ROLES
--
-- leave_workspace_atomic (migration 027) blocks the sole
-- MANAGE_WORKSPACE_SETTINGS holder from leaving, so a workspace can never
-- end up with nobody able to manage billing/general settings. But it
-- never checked MANAGE_ROLES the same way. In every seeded role
-- (migration 010's create_workspace_atomic) the two permissions travel
-- together on Owner, so this was never reachable through the app's
-- default setup — but nothing stops an admin from creating a custom role
-- that holds MANAGE_ROLES without MANAGE_WORKSPACE_SETTINGS. If that
-- role's sole holder leaves, the workspace keeps someone who can manage
-- settings/billing but permanently loses anyone who can create/edit
-- roles, change permission overrides, or invite a new admin — a
-- one-way lockout of the permission system itself, with no self-service
-- recovery.
--
-- Same fix shape as 027: check both floors independently inside the same
-- locked, single-transaction function, so a leaver blocked by either one
-- is refused before any row is touched.
-- ============================================================

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
BEGIN
  -- Lock every active membership row for this workspace before reading
  -- anything, so a concurrent call for the SAME workspace blocks here
  -- until this transaction commits or rolls back — no two leaves for the
  -- same workspace can ever evaluate their guard against the same
  -- pre-leave snapshot.
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

  -- FIX (migration 034): same floor, for MANAGE_ROLES specifically —
  -- independent of the settings check above, since a custom role can
  -- hold one permission without the other.
  IF COALESCE(v_leaver_roles_admin, false) THEN
    SELECT count(*) INTO v_other_roles_admins
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active' AND id <> v_member_id
      AND (effective_permissions->>'MANAGE_ROLES')::boolean IS TRUE;

    IF v_other_roles_admins = 0 THEN
      RAISE EXCEPTION 'sole_roles_admin';
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
