-- FIX (deep audit, Workspace lifecycle round — flagship finding).
--
-- Part 1: leave_workspace_atomic's creator-lockout guard (migration 038) only
-- ever fired for `plan_tier = 'trial'` — by that migration's own comment,
-- deliberately: "a workspace already upgraded off trial has no cap to get
-- stuck against... no attempt to build a real ownership-transfer feature
-- here." Migration 039 later DID build that feature
-- (transfer_workspace_ownership / api/workspace/transfer-ownership) — but
-- its only authority check is `created_by = session.id`, which only works
-- while the creator is still an active member. Nothing was ever added
-- requiring the creator to transfer ownership BEFORE leaving a non-trial
-- workspace, so the exact "permanent, unrecoverable lockout" 038 and 039
-- were built to prevent was still fully reachable — just one plan tier over.
--
-- Concretely: a creator delegates MANAGE_WORKSPACE_SETTINGS to a co-admin
-- (normal team growth, and the only thing that lifts the sole_admin leave
-- guard below), then leaves. `workspaces.created_by` now permanently points
-- at someone who is no longer a member. transfer_workspace_ownership can
-- never be called by anyone again (its `not_owner` check can only ever be
-- satisfied by that exact departed user's own session). The workspace keeps
-- running, but can never be transferred to a new legitimate owner again —
-- its only remaining lifecycle move is deletion (workspace/delete's existing
-- "owner inactive -> a settings admin may still delete it" fallback still
-- works, so it's not un-deletable, just un-transferable and
-- un-recoverable-as-a-going-concern).
--
-- Fix: block the workspace's own creator from leaving regardless of plan
-- tier, with a distinct exception code so the two cases keep their own
-- (already-shipped, still-accurate) messaging. `created_by` is exactly as
-- irreplaceable a "floor" as MANAGE_WORKSPACE_SETTINGS/MANAGE_ROLES/etc.
-- below it — it just isn't modeled as a permission, so admin-floor.ts's
-- generalized would_orphan_permissions machinery never covered it.
--
-- Part 2: restore_workspace_atomic (migration 065) lets the workspace's
-- `created_by` restore it by identity alone, with no active-membership
-- requirement (deliberate — it has to work even when the deletion itself
-- deactivated their membership). But it only reactivates workspace_members
-- rows matching `deactivated_at = <this deletion's own timestamp>` — a
-- creator who left EARLIER (a different timestamp, now blocked by Part 1
-- going forward, but already possible in existing data) passes the
-- `created_by = p_user_id` check and "successfully" restores the workspace,
-- while remaining a non-member of it: active_workspace_id gets pointed at a
-- workspace they have no active membership in, getSession()'s
-- pickFallbackMembership silently sends them elsewhere on every request, and
-- the "workspace restored" email's "Open workspace" CTA leads nowhere real —
-- directly contradicting its own "everything is back exactly as it was"
-- copy. Fix: after the deletion-time reactivation, also ensure the restorer
-- themselves ends up an active member — reactivating their own membership
-- row regardless of when it was deactivated, since they're the one who just
-- proved (by identity check) they're allowed to be here.

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

  -- FIX: was `AND v_ws_plan_tier = 'trial'` — see migration header comment.
  -- The creator is blocked from leaving on ANY plan tier now; which message
  -- fires (still distinct, still pointing at the right way out) depends on
  -- whether the workspace is still on trial.
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

CREATE OR REPLACE FUNCTION public.restore_workspace_atomic(p_workspace_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_created_by uuid;
  v_deleted_at timestamptz;
BEGIN
  SELECT created_by, deleted_at INTO v_created_by, v_deleted_at
  FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;

  IF v_created_by IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;

  IF v_deleted_at IS NULL THEN
    RAISE EXCEPTION 'not_deleted';
  END IF;

  IF v_created_by <> p_user_id THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  IF v_deleted_at < now() - interval '30 days' THEN
    RAISE EXCEPTION 'restore_window_expired';
  END IF;

  UPDATE public.workspaces SET deleted_at = NULL WHERE id = p_workspace_id;

  UPDATE public.workspace_members
  SET status = 'active', deactivated_at = NULL
  WHERE workspace_id = p_workspace_id AND status = 'deactivated' AND deactivated_at = v_deleted_at;

  -- FIX: the block above only ever reactivated members THIS deletion
  -- deactivated (correct — someone who genuinely left earlier shouldn't be
  -- swept back in). But the restorer is a special case: they just proved,
  -- by identity, that they're the one person allowed to bring this
  -- workspace back. If that left them with no active membership row (their
  -- own was deactivated at a different time than the deletion — e.g. they'd
  -- left before this deletion happened, in old data predating the
  -- leave_workspace_atomic fix above), reactivate their own row now
  -- regardless of timestamp, so "restore" actually leaves them with access
  -- to what they restored, matching what the restored-workspace email
  -- already promises them.
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active'
  ) THEN
    UPDATE public.workspace_members
    SET status = 'active', deactivated_at = NULL
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
  END IF;

  -- Land the restorer straight back in the workspace they just brought
  -- back, rather than wherever the deletion-time reassignment (see
  -- workspace/delete's own comment, and pickFallbackMembership in
  -- lib/auth/session.ts) sent them.
  UPDATE public.users SET active_workspace_id = p_workspace_id WHERE id = p_user_id;
END;
$$;
