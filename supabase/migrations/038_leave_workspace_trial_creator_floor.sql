-- ============================================================
-- ScopeGov — Migration 038: leave_workspace_atomic didn't account for
-- the trial-cap lockout a creator can trigger against themselves
--
-- Migration 019's one_active_trial_per_creator unique index keys off
-- workspaces.created_by alone, with no regard for whether the creator is
-- still an active member of that workspace. leave_workspace_atomic had no
-- guard preventing the creator of a trial-tier workspace from leaving it
-- like any other member.
--
-- Once they did, the workspace kept counting against their one-trial cap
-- forever: deleted_at stays null (leaving isn't deleting), and deleting it
-- themselves afterward is no longer possible — workspace/delete/route.ts's
-- getSession()-based permission check requires an ACTIVE membership with
-- MANAGE_WORKSPACE_SETTINGS, which they no longer have. workspace/create's
-- 23505 conflict on that index would then permanently 409 for them, with
-- no self-service way out — "contact support@scopegov.app" forever, for a
-- workspace they can no longer see or touch.
--
-- Worse if the workspace hadn't finished onboarding yet and had other
-- invited members in it: complete-onboarding/route.ts is scoped to
-- created_by = user.id, and onboarding-status/route.ts's own query only
-- ever looks at the caller's ACTIVE memberships — once the creator's
-- membership is deactivated, that workspace stops showing up for them at
-- all, so there's no UI path back to finish it. Any other member who
-- joined before the creator left is left on the 'waiting' screen
-- (app/onboarding/page.tsx) indefinitely, since no one else can ever call
-- complete-onboarding for it.
--
-- Fixed the same way 027 and 034 already fix a leave-time floor: check it
-- inside the same locked, single-transaction function, before any row is
-- touched. Scoped narrowly to plan_tier = 'trial' (a workspace already
-- upgraded off trial has no cap to get stuck against) and to workspaces
-- this user actually created (leaving someone ELSE's trial workspace is
-- unaffected either way). There's deliberately no equivalent block for a
-- non-trial workspace, and no attempt to build a real ownership-transfer
-- feature here — this only closes the self-inflicted lockout; a creator
-- who wants to hand off a trial workspace for good should delete it
-- (Settings > Danger Zone) or wait until it's upgraded off trial first.
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
  v_ws_created_by         uuid;
  v_ws_plan_tier          text;
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

  IF COALESCE(v_leaver_roles_admin, false) THEN
    SELECT count(*) INTO v_other_roles_admins
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active' AND id <> v_member_id
      AND (effective_permissions->>'MANAGE_ROLES')::boolean IS TRUE;

    IF v_other_roles_admins = 0 THEN
      RAISE EXCEPTION 'sole_roles_admin';
    END IF;
  END IF;

  -- FIX (migration 038): see header — a leaving creator whose workspace
  -- is still on 'trial' would permanently occupy their one-trial slot
  -- with no way back in to delete it themselves.
  SELECT created_by, plan_tier INTO v_ws_created_by, v_ws_plan_tier
  FROM public.workspaces WHERE id = p_workspace_id;

  IF v_ws_created_by = p_user_id AND v_ws_plan_tier = 'trial' THEN
    RAISE EXCEPTION 'trial_creator';
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
