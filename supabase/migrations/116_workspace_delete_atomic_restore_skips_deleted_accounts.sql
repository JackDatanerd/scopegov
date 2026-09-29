-- 116_workspace_delete_atomic_restore_skips_deleted_accounts.sql
--
-- Workspace lifecycle independent pass (round 1).
--
-- B2 / B9 — workspace delete was four separate, non-transactional writes from the
-- route (soft-delete, deactivate members, reassign active workspaces, ...):
--   * the soft-delete UPDATE had no `deleted_at IS NULL` guard, so two overlapping
--     DELETE requests (double click, retry after a slow response) re-stamped
--     deleted_at with a NEWER timestamp than the one the members were deactivated
--     with. restore_workspace_atomic / admin_restore_workspace reactivate members by
--     EXACT deactivated_at match, so that restore then reactivated nobody;
--   * if the member-deactivation write failed after the soft-delete succeeded, the
--     workspace stayed deleted with every member still 'active' (no rollback).
-- delete_workspace_atomic does all of it in one transaction under a row lock, and
-- re-checks the "live document / money" blockers under that lock so a signature or
-- payment landing between the route's pre-checks and the write can't slip through.
--
-- B10 — restore reactivated members whose account had since been deleted.
-- account/delete only processes status='active' memberships, so someone whose row
-- was already deactivated by a workspace delete keeps that row after deleting their
-- account. A later restore then turned it back into an ACTIVE membership for a
-- deleted (later anonymized) account: it holds a seat, counts toward the admin /
-- permission floors, and shows as a ghost member. Both restore functions now leave
-- rows belonging to deleted accounts deactivated. (team/[id] reactivate already
-- refuses these with a 409; restore was the path that missed it.)

CREATE OR REPLACE FUNCTION public.delete_workspace_atomic(p_workspace_id uuid, p_now timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_deleted_at timestamptz;
  v_exists boolean;
BEGIN
  SELECT true, deleted_at INTO v_exists, v_deleted_at
  FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;

  IF v_exists IS NOT TRUE THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;
  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_deleted';
  END IF;

  -- Same blockers the route reports one-by-one with friendly messages, re-checked
  -- here under the workspace lock (the route's reads are not atomic with its write).
  IF EXISTS (SELECT 1 FROM public.sow_documents
             WHERE workspace_id = p_workspace_id
               AND status IN ('signed', 'awaiting_signature', 'changes_requested'))
     OR EXISTS (SELECT 1 FROM public.change_orders
                WHERE workspace_id = p_workspace_id
                  AND status IN ('accepted', 'awaiting_response', 'awaiting_countersignature', 'countered', 'stalled'))
     OR EXISTS (SELECT 1 FROM public.invoice_payments WHERE workspace_id = p_workspace_id)
     OR EXISTS (SELECT 1 FROM public.invoices
                WHERE workspace_id = p_workspace_id AND status IN ('sent', 'overdue'))
  THEN
    RAISE EXCEPTION 'blocked_by_live_documents';
  END IF;

  UPDATE public.workspaces SET deleted_at = p_now, updated_at = p_now WHERE id = p_workspace_id;

  -- Only genuine members (see migration 112: pending/expired invites are not members
  -- and must never be stamped, or a later restore would turn them into ghosts).
  UPDATE public.workspace_members
  SET status = 'deactivated', deactivated_at = p_now
  WHERE workspace_id = p_workspace_id AND status = 'active';

  -- Move everyone whose active workspace was this one onto their oldest live
  -- workspace, preferring one whose onboarding is finished (mirrors
  -- pickFallbackMembership in lib/auth/session.ts); NULL when they have none.
  UPDATE public.users u
  SET active_workspace_id = (
    SELECT wm.workspace_id
    FROM public.workspace_members wm
    JOIN public.workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = u.id
      AND wm.status = 'active'
      AND w.deleted_at IS NULL
      AND wm.workspace_id <> p_workspace_id
    ORDER BY (w.onboarding_completed_at IS NULL), wm.created_at ASC
    LIMIT 1
  )
  WHERE u.active_workspace_id = p_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_workspace_atomic(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_workspace_atomic(uuid, timestamptz) TO service_role;

-- ── restore_workspace_atomic: 112's body + skip deleted accounts ─────────────
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

  -- (112) only rows that were genuinely members come back.
  -- (116) ...and only if the person's account still exists.
  UPDATE public.workspace_members wm
  SET status = 'active', deactivated_at = NULL
  WHERE wm.workspace_id = p_workspace_id AND wm.status = 'deactivated' AND wm.deactivated_at = v_deleted_at
    AND wm.user_id IS NOT NULL AND wm.joined_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = wm.user_id AND u.deleted_at IS NOT NULL);

  -- (112) leftover never-accepted invite rows from pre-fix deletes.
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

  -- (080) the restorer always gets their own row back.
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active'
  ) THEN
    UPDATE public.workspace_members
    SET status = 'active', deactivated_at = NULL
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
  END IF;

  UPDATE public.users SET active_workspace_id = p_workspace_id WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.restore_workspace_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_workspace_atomic(uuid, uuid) TO service_role;

-- ── admin_restore_workspace: 092's body + skip deleted accounts ──────────────
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

  UPDATE public.workspace_members wm
  SET status = 'active', deactivated_at = NULL
  WHERE wm.workspace_id = p_workspace_id AND wm.status = 'deactivated' AND wm.deactivated_at = v_suspended_at
    AND wm.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = wm.user_id AND u.deleted_at IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_restore_workspace(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_restore_workspace(uuid) TO service_role;
