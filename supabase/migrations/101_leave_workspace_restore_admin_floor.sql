-- FIX (Workspace lifecycle independent pass, W1).
--
-- Migration 071 added a generalized `would_orphan_permissions` floor to leave_workspace_atomic:
-- the sole active holder of MANAGE_BILLING, INVITE_MEMBERS or VIEW_AUDIT_LOG may not leave.
-- Migration 080 then re-issued the entire function to add the creator-must-transfer guard, but
-- was written from the pre-071 (034/038-era) body and silently DROPPED the 071 check in the
-- process — it never mentions removing it, and nothing since has restored it. Since 080, the
-- sole holder of billing / invites / the audit log could leave the workspace (and account
-- deletion, which calls this same RPC, could remove them too), permanently stranding that
-- capability with no one left to grant it. workspace/leave/route.ts and account/delete/route.ts
-- both still parse a `would_orphan_permissions:` error prefix — that handling has been dead code
-- since 080 shipped.
--
-- This re-issues the function with 080's current body untouched, plus the 071 check restored in
-- its original position (after sole_admin / sole_roles_admin, before the creator-transfer guard).
-- Nothing else changes.

CREATE OR REPLACE FUNCTION public.leave_workspace_atomic(p_workspace_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member_id             uuid;
  v_leaver_settings_admin boolean;
  v_leaver_roles_admin    boolean;
  v_leaver_permissions    jsonb;
  v_active_count          int;
  v_other_settings_admins int;
  v_other_roles_admins    int;
  v_current_active_ws     uuid;
  v_fallback_ws           uuid;
  v_ws_created_by         uuid;
  v_ws_plan_tier          text;
  v_orphaned              text[];
BEGIN
  PERFORM 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active'
    FOR UPDATE;

  SELECT id,
         (effective_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean,
         (effective_permissions->>'MANAGE_ROLES')::boolean,
         effective_permissions
    INTO v_member_id, v_leaver_settings_admin, v_leaver_roles_admin, v_leaver_permissions
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

  -- Restored from migration 071 (silently dropped by 080's rewrite).
  SELECT array_agg(protected.perm) INTO v_orphaned
  FROM (VALUES ('MANAGE_BILLING'), ('INVITE_MEMBERS'), ('VIEW_AUDIT_LOG')) AS protected(perm)
  WHERE (v_leaver_permissions -> protected.perm) = 'true'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active' AND wm.id <> v_member_id
        AND (wm.effective_permissions -> protected.perm) = 'true'::jsonb
    );

  IF v_orphaned IS NOT NULL AND array_length(v_orphaned, 1) > 0 THEN
    RAISE EXCEPTION 'would_orphan_permissions:%', array_to_string(v_orphaned, ',');
  END IF;

  SELECT created_by, plan_tier INTO v_ws_created_by, v_ws_plan_tier
  FROM public.workspaces WHERE id = p_workspace_id;

  IF v_ws_created_by = p_user_id THEN
    IF v_ws_plan_tier = 'trial' THEN
      RAISE EXCEPTION 'trial_creator';
    ELSE
      RAISE EXCEPTION 'owner_must_transfer';
    END IF;
  END IF;

  UPDATE public.workspace_members
  SET status = 'deactivated', deactivated_at = now()
  WHERE id = v_member_id;

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
