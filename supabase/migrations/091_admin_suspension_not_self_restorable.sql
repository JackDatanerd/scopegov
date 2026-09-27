-- 091_admin_suspension_not_self_restorable.sql
--
-- FIX (deep audit, Workspace lifecycle re-pass round 3 — flagship
-- finding): migration 090's admin_suspend_workspace/admin_restore_workspace
-- deliberately reuse workspaces.deleted_at as the same state-change primitive
-- self-service delete/restore already use — see that migration's own
-- comment, which reasons carefully about why the ADMIN pair shouldn't
-- inherit restore_workspace_atomic's owner-only/30-day rules, but never
-- considers the reverse: restore_workspace_atomic has no way to know a given
-- `deleted_at` came from an admin suspension rather than the workspace's own
-- creator deleting it.
--
-- Concretely: a platform admin suspends a workspace (fraud, non-payment
-- investigation, ToS violation — admin_suspend_workspace also drives a
-- Paystack subscription cancellation at the call site in
-- app/api/admin/workspaces/[id]/suspend/route.ts) and within 30 days the
-- workspace's own creator calls the perfectly ordinary self-service
-- POST /api/workspace/restore themselves. It passes every check
-- restore_workspace_atomic has (created_by = them, deleted_at set, within
-- the window) and quietly un-suspends the workspace, reactivates every
-- member, and re-enables their Paystack subscription — fully reversing the
-- admin's action with zero notice to the admin. The workspace even shows up
-- in the creator's own "restorable workspaces" list (GET
-- /api/workspace/restore), inviting exactly this.
--
-- Fix: a dedicated boolean that only the admin pair ever touches. Self-
-- service restore refuses outright (new, distinct exception code) rather
-- than silently clearing it — an admin-suspended workspace is not
-- self-service business as usual, it needs a human on the support side to
-- reverse it via admin_restore_workspace. The self-service GET listing also
-- excludes it, so the option is never even offered.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS suspended_by_admin boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.admin_suspend_workspace(p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.workspaces SET deleted_at = now(), suspended_by_admin = true, updated_at = now()
  WHERE id = p_workspace_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found_or_already_suspended';
  END IF;
  UPDATE public.workspace_members SET status = 'deactivated'
  WHERE workspace_id = p_workspace_id AND status = 'active';
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_restore_workspace(p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.workspaces SET deleted_at = NULL, suspended_by_admin = false, updated_at = now()
  WHERE id = p_workspace_id AND deleted_at IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found_or_not_suspended';
  END IF;
  -- Reactivate members who were active immediately before suspension.
  -- Same limitation restore_workspace_atomic's own header accepts: a member
  -- deactivated for an unrelated reason moments before this suspension is
  -- indistinguishable from one deactivated BY it, so both come back. Low
  -- stakes here (an admin can always re-deactivate a specific member
  -- through Team settings afterward) and consistent with the self-service
  -- restore's own accepted trade-off.
  UPDATE public.workspace_members SET status = 'active'
  WHERE workspace_id = p_workspace_id AND status = 'deactivated';
END;
$$;

-- FIX: restore_workspace_atomic (migration 065, extended by 080) had no
-- concept of admin suspension at all — see this migration's own header
-- comment for the exact bypass this closes. `suspended_by_admin` is checked
-- right after confirming the row is deleted at all, before the owner/window
-- checks below it, so a non-owner poking at a suspended workspace's id gets
-- the same categorical refusal an owner would (nothing here is a "should
-- this person be allowed to try" question — a suspended workspace simply
-- isn't self-service business until an admin lifts it).
CREATE OR REPLACE FUNCTION public.restore_workspace_atomic(p_workspace_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_created_by uuid;
  v_deleted_at timestamptz;
  v_suspended_by_admin boolean;
BEGIN
  SELECT created_by, deleted_at, suspended_by_admin INTO v_created_by, v_deleted_at, v_suspended_by_admin
  FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;

  IF v_created_by IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;

  IF v_deleted_at IS NULL THEN
    RAISE EXCEPTION 'not_deleted';
  END IF;

  IF v_suspended_by_admin THEN
    RAISE EXCEPTION 'admin_suspended';
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

  -- FIX (migration 080): the block above only ever reactivated members THIS
  -- deletion deactivated (correct — someone who genuinely left earlier
  -- shouldn't be swept back in). But the restorer is a special case: they
  -- just proved, by identity, that they're the one person allowed to bring
  -- this workspace back. If that left them with no active membership row
  -- (their own was deactivated at a different time than the deletion — e.g.
  -- they'd left before this deletion happened, in old data predating the
  -- leave_workspace_atomic fix), reactivate their own row now regardless of
  -- timestamp, so "restore" actually leaves them with access to what they
  -- restored, matching what the restored-workspace email already promises
  -- them.
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
