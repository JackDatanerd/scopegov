-- ============================================================
-- ScopeGov — Migration 039: workspace ownership transfer
--
-- FEATURE GAP (deep audit, Workspace lifecycle + Onboarding re-pass):
-- there was no way for a workspace's creator to hand off `created_by` to
-- someone else. That gap is what made migration 038's leave-time guard
-- necessary in the first place — a creator who leaves their own
-- trial-tier workspace has no way back in to delete it, permanently
-- occupying their one_active_trial_per_creator slot (019) with no
-- recovery but contacting support, and if the workspace hadn't finished
-- onboarding yet, any other invited member is stuck on the 'waiting'
-- screen forever (complete-onboarding/route.ts is scoped to
-- created_by = user.id).
--
-- 038 stops the damage; this is the actual way out it pointed at. Once
-- ownership is transferred, the workspace no longer counts against the
-- ORIGINAL creator's trial cap at all (the unique index is keyed on
-- created_by), freeing them to create a new trial workspace of their own,
-- and — if onboarding was never finished — the NEW creator can now call
-- complete-onboarding for it, unblocking anyone waiting on it.
--
-- Design, mirroring the same atomic-function pattern as
-- create_workspace_atomic (001) and leave_workspace_atomic (027/034/038):
--   - Only the CURRENT creator can initiate a transfer (not any admin —
--     ownership is the creator's to give away, same reasoning already
--     used to scope complete-onboarding to created_by).
--   - The recipient must already be an ACTIVE member holding
--     MANAGE_WORKSPACE_SETTINGS. Deliberately not auto-granting that
--     permission as part of the transfer — forcibly reassigning a
--     role behind the scenes would step on the workspace's own
--     Team > Roles configuration. If the intended recipient doesn't have
--     it yet, the app/api/workspace/transfer-ownership/route.ts GET
--     endpoint tells the caller so, and it's a one-step fix via
--     Team > Roles before retrying.
--   - Everything read-then-write happens under a lock on the workspace
--     row itself, so two concurrent transfer attempts (or a transfer
--     racing a leave/delete) can't interleave.
-- ============================================================

CREATE OR REPLACE FUNCTION public.transfer_workspace_ownership(
  p_workspace_id uuid, p_current_owner_id uuid, p_new_owner_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_created_by          uuid;
  v_deleted_at          timestamptz;
  v_target_member_id    uuid;
  v_target_permissions  jsonb;
BEGIN
  SELECT created_by, deleted_at INTO v_created_by, v_deleted_at
  FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;

  IF v_created_by IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;

  IF v_created_by <> p_current_owner_id THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  IF p_new_owner_id = p_current_owner_id THEN
    RAISE EXCEPTION 'same_owner';
  END IF;

  SELECT id, effective_permissions INTO v_target_member_id, v_target_permissions
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_new_owner_id AND status = 'active'
  FOR UPDATE;

  IF v_target_member_id IS NULL THEN
    RAISE EXCEPTION 'target_not_active_member';
  END IF;

  IF NOT COALESCE((v_target_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean, false) THEN
    RAISE EXCEPTION 'target_lacks_permission';
  END IF;

  UPDATE public.workspaces SET created_by = p_new_owner_id WHERE id = p_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_workspace_ownership(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_workspace_ownership(uuid, uuid, uuid) TO service_role;
