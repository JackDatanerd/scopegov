-- 112_restore_workspace_skips_unaccepted_invites.sql
--
-- FIX (deep audit, Team & Invites independent pass — B1, HIGH): workspace
-- delete → restore turned pending invites into ghost ACTIVE members.
--
-- app/api/workspace/delete/route.ts used to deactivate every row that wasn't
-- already deactivated (`.neq('status','deactivated')`), which included PENDING
-- and EXPIRED invite rows (status 'invited' / 'expired'; user_id NULL — or an
-- existing user's id, for an invite that was never accepted) and stamped them
-- with deactivated_at. restore_workspace_atomic (091) then reactivates every
-- row whose deactivated_at equals the workspace's deleted_at, with no check
-- that the row was ever a member. Result after delete + restore:
--   * an "active" member with no account (or one that never consented);
--   * it consumes a seat, so invites / accepts / reactivations start failing;
--   * the real invitee's link now says "already accepted";
--   * admin-floor / would-orphan checks count it as a holder of
--     MANAGE_ROLES / INVITE_MEMBERS / etc. (the sole real holder can then be
--     removed, which the floor exists to prevent);
--   * it appears as an "Unknown" member card and in the project assignee picker.
--
-- The route is fixed in the same change (only `active` rows are deactivated).
-- This migration:
--   1. re-issues restore_workspace_atomic (091's body, otherwise untouched) so
--      it only reactivates rows that were really members (user_id and
--      joined_at both set — joined_at is set by accept, signup and every
--      workspace-creation path, and by nothing else), and removes the
--      never-accepted invite rows a pre-fix delete left behind;
--   2. heals ghosts already created by pre-fix restores;
--   3. adds a CHECK so an active membership without a user cannot exist.

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

  -- FIX (112): only rows that were genuinely members come back. A row with no
  -- user_id / joined_at is a leftover invite (see header) and must never
  -- become an active membership.
  UPDATE public.workspace_members
  SET status = 'active', deactivated_at = NULL
  WHERE workspace_id = p_workspace_id AND status = 'deactivated' AND deactivated_at = v_deleted_at
    AND user_id IS NOT NULL AND joined_at IS NOT NULL;

  -- Leftover invite rows that a pre-fix delete deactivated (never accepted: no joined_at, and no
  -- user_id for an address without an account): unusable junk — the equivalent of a revoked invite — so
  -- drop them rather than leave permanent "Deactivated" cards. An invite to an EXISTING account (user_id
  -- set, joined_at NULL) goes too: leaving it would let an admin "reactivate" access nobody accepted.
  DELETE FROM public.project_members
  WHERE member_id IN (
    SELECT id FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'deactivated'
      AND deactivated_at = v_deleted_at AND (user_id IS NULL OR joined_at IS NULL)
      AND user_id IS DISTINCT FROM p_user_id
  );
  DELETE FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND status = 'deactivated'
    AND deactivated_at = v_deleted_at AND (user_id IS NULL OR joined_at IS NULL)
    AND user_id IS DISTINCT FROM p_user_id;

  -- (080) The restorer is a special case: they just proved, by identity, that
  -- they're the one person allowed to bring this workspace back. If that left
  -- them with no active membership row (their own was deactivated at a
  -- different time than the deletion), reactivate their own row regardless of
  -- timestamp.
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active'
  ) THEN
    UPDATE public.workspace_members
    SET status = 'active', deactivated_at = NULL
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
  END IF;

  -- Land the restorer straight back in the workspace they just brought back.
  UPDATE public.users SET active_workspace_id = p_workspace_id WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.restore_workspace_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_workspace_atomic(uuid, uuid) TO service_role;

-- ── Heal ghosts created by restores that ran before this fix ─────────────────
-- (a) Active rows with NO user: structurally cannot be members. They are
--     leftover invites; drop them (an admin can simply re-invite).
DELETE FROM public.project_members
WHERE member_id IN (
  SELECT id FROM public.workspace_members WHERE status = 'active' AND user_id IS NULL
);
DELETE FROM public.workspace_members WHERE status = 'active' AND user_id IS NULL;

-- (b) Active rows WITH a user but no joined_at that still carry an invite token: an invite to an
--     existing account that a pre-fix restore silently activated without the person ever accepting.
--     Deactivate (not delete) — non-destructive and reversible from Team settings if this ever caught a
--     genuine member. Never touches a workspace's creator (their row is not an invite).
DELETE FROM public.project_members
WHERE member_id IN (
  SELECT wm.id FROM public.workspace_members wm
  WHERE wm.status = 'active' AND wm.user_id IS NOT NULL AND wm.joined_at IS NULL AND wm.invite_token IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = wm.workspace_id AND w.created_by = wm.user_id)
);
UPDATE public.workspace_members wm
SET status = 'deactivated', deactivated_at = now()
WHERE wm.status = 'active' AND wm.user_id IS NOT NULL AND wm.joined_at IS NULL AND wm.invite_token IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = wm.workspace_id AND w.created_by = wm.user_id);

-- ── Guard: an active membership must have a user ─────────────────────────────
-- (Not also joined_at: fixtures and older tooling insert active rows without
-- it. user_id is the structural invariant; the functions above and the
-- reactivate route enforce the joined_at side.)
ALTER TABLE public.workspace_members DROP CONSTRAINT IF EXISTS workspace_members_active_has_user;
ALTER TABLE public.workspace_members
  ADD CONSTRAINT workspace_members_active_has_user CHECK (status <> 'active' OR user_id IS NOT NULL);
