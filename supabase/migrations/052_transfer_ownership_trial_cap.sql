-- ============================================================
-- ScopeGov — Migration 052: ownership transfer must spend the
-- recipient's trial slot when the workspace being handed off is
-- still on the trial plan
--
-- FINDING (round 14 independent audit, Workspace lifecycle +
-- Onboarding re-pass): migration 039's transfer_workspace_ownership
-- reassigns workspaces.created_by to the new owner but never touches
-- public.users.trial_used_at (048) for that new owner. Combined with
-- one_active_trial_per_creator (019, a unique index on created_by
-- scoped to plan_tier='trial'), this makes the concurrent-trial cap
-- the whole system is built around trivially bypassable:
--
--   1. User A creates trial workspace W1 (created_by=A). A's
--      trial_used_at is set.
--   2. A invites a disposable throwaway account B, grants B
--      MANAGE_WORKSPACE_SETTINGS, transfers W1 to B. created_by
--      flips to B — B's trial_used_at is still NULL, and A's slot on
--      the unique index is freed (W1 no longer counts against A).
--   3. Still inside 048's 24h grace window, A creates a second trial
--      workspace W2 — A's own trial_used_at check still lets this
--      through, while W1 keeps running fully under B's name.
--   4. Repeat with fresh disposable accounts C, D, E... — each
--      hand-off frees A's slot again, and no recipient ever spends a
--      trial slot of their own, since transfer never set one.
--
-- Net effect: a single actor can accumulate an unbounded number of
-- CONCURRENTLY ACTIVE 14-day trial workspaces using nothing but
-- disposable member accounts — defeating both the concurrent cap
-- (019) and the lifetime cap (048) in one move, despite each having
-- been independently hardened in isolation across separate audit
-- rounds that never traced the interaction between transfer and the
-- trial system together.
--
-- Fix: receiving ownership of a still-trial workspace now costs the
-- recipient their own trial slot, exactly like creating one does.
-- Scoped narrowly — only sets trial_used_at, only when it was NULL
-- (never overwrites an already-used slot, and never re-triggers
-- TRIAL_ALREADY_USED against the recipient purely for accepting a
-- transfer), and only for a workspace still at plan_tier='trial' (a
-- workspace already upgraded off trial has no cap to protect, so
-- transferring an Agency-tier workspace to a brand-new user must not
-- burn their one free trial for something that was never a trial to
-- begin with).
-- ============================================================

CREATE OR REPLACE FUNCTION public.transfer_workspace_ownership(
  p_workspace_id uuid, p_current_owner_id uuid, p_new_owner_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_created_by          uuid;
  v_deleted_at          timestamptz;
  v_plan_tier           text;
  v_target_member_id    uuid;
  v_target_permissions  jsonb;
BEGIN
  SELECT created_by, deleted_at, plan_tier INTO v_created_by, v_deleted_at, v_plan_tier
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

  -- FIX (migration 052): see header — receiving ownership of a live
  -- trial workspace now spends the recipient's own trial slot, the
  -- same as create_workspace_atomic already does for a self-created
  -- one. Lock the recipient's row before the read-then-write so two
  -- concurrent transfers to the same brand-new recipient (of two
  -- different trial workspaces) can't both read trial_used_at as
  -- NULL and both slip through.
  IF v_plan_tier = 'trial' THEN
    PERFORM 1 FROM public.users WHERE id = p_new_owner_id FOR UPDATE;

    UPDATE public.users
    SET trial_used_at = COALESCE(trial_used_at, now())
    WHERE id = p_new_owner_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_workspace_ownership(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_workspace_ownership(uuid, uuid, uuid) TO service_role;
