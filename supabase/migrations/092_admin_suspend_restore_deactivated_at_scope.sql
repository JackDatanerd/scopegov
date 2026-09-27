-- 092_admin_suspend_restore_deactivated_at_scope.sql
--
-- FIX (deep audit, Workspace lifecycle re-pass round 4 — flagship
-- finding): migration 091's admin_suspend_workspace never stamped
-- `deactivated_at` on the members it deactivated, and
-- admin_restore_workspace's reactivation had NO timestamp filter at all —
-- `WHERE workspace_id = p_workspace_id AND status = 'deactivated'` matches
-- every member who has EVER left or been removed from the workspace, not
-- just the ones this specific suspension deactivated. That migration's own
-- comment claims this is "the same limitation restore_workspace_atomic's
-- own header accepts... a member deactivated for an unrelated reason
-- MOMENTS BEFORE this suspension" — but restore_workspace_atomic actually
-- filters on `deactivated_at = v_deleted_at` (an exact timestamp match, a
-- genuinely narrow window); admin_restore_workspace filtered on nothing,
-- which is a categorically different, unbounded blast radius.
--
-- Concretely: a workspace with completely ordinary turnover — people who
-- left via workspace/leave (leave_workspace_atomic always stamps
-- deactivated_at) or were removed via Team settings (deactivate_member_atomic,
-- migration 070, same) months or years ago — gets admin-suspended for an
-- unrelated reason (fraud review, non-payment) and later admin-restored.
-- Every one of those long-departed members — not just whoever was active
-- at the moment of suspension — comes back as a fully active member with
-- whatever role/permissions they last held. A former employee removed for
-- cause regains full workspace access the instant support lifts a
-- suspension that had nothing to do with them.
--
-- Fix: same pattern restore_workspace_atomic already uses. Stamp
-- deactivated_at = now() in admin_suspend_workspace (captured once and
-- reused for both the workspace's own deleted_at and every member row, so
-- they match exactly), and filter admin_restore_workspace's reactivation on
-- that same timestamp. A member deactivated at any other time — including
-- the "unrelated reason moments before" edge case restore_workspace_atomic
-- itself accepts as a known, narrow limitation — no longer comes back.

CREATE OR REPLACE FUNCTION public.admin_suspend_workspace(p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  UPDATE public.workspaces SET deleted_at = v_now, suspended_by_admin = true, updated_at = v_now
  WHERE id = p_workspace_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found_or_already_suspended';
  END IF;
  -- FIX: now stamps deactivated_at = v_now (matching this suspension's own
  -- deleted_at exactly), so admin_restore_workspace below can tell "active
  -- when THIS suspension fired" apart from "left/removed at some earlier,
  -- unrelated time."
  UPDATE public.workspace_members SET status = 'deactivated', deactivated_at = v_now
  WHERE workspace_id = p_workspace_id AND status = 'active';
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_restore_workspace(p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_suspended_at timestamptz;
BEGIN
  SELECT deleted_at INTO v_suspended_at
  FROM public.workspaces WHERE id = p_workspace_id AND deleted_at IS NOT NULL
  FOR UPDATE;

  IF v_suspended_at IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found_or_not_suspended';
  END IF;

  UPDATE public.workspaces SET deleted_at = NULL, suspended_by_admin = false, updated_at = now()
  WHERE id = p_workspace_id;

  -- FIX: only reactivate members THIS suspension deactivated (exact
  -- deactivated_at match, same discipline restore_workspace_atomic already
  -- applies to the self-service pair) — not every member ever deactivated
  -- for any reason at any time in this workspace's history.
  UPDATE public.workspace_members SET status = 'active', deactivated_at = NULL
  WHERE workspace_id = p_workspace_id AND status = 'deactivated' AND deactivated_at = v_suspended_at;
END;
$$;
