-- ============================================================
-- ScopeGov — Migration 065: fallback active_workspace_id must
-- prefer an onboarding-complete workspace
--
-- FINDING (deep audit, Workspace lifecycle + Onboarding re-pass —
-- flagship finding): every place in the codebase that has to pick a
-- FALLBACK active workspace for a user — lib/auth/session.ts's
-- getSession() and resolveActiveWorkspaceId(), workspace/delete's
-- post-delete reassignment loop, and this function
-- (leave_workspace_atomic, migration 027) — picked strictly by
-- oldest created_at among the user's remaining active memberships,
-- with zero regard for whether that workspace had actually finished
-- onboarding.
--
-- A user who belongs to an older, still-incomplete workspace (e.g.
-- they're an invited member parked on the onboarding wizard's
-- 'waiting' screen for someone else's slow-to-launch workspace) AND
-- a newer, fully-onboarded one could lose their active workspace (by
-- leaving it here, or via workspace/delete — now fixed in the same
-- round, see that route's own comment) and get bounced into the
-- incomplete one — the wizard or the waiting screen — instead of the
-- workspace that actually works, purely because it happened to be
-- created first.
--
-- Fix: same "prefer a completed workspace, oldest-first among ties"
-- pick the two application-layer call sites now share via
-- pickFallbackMembership() in lib/auth/session.ts, applied here at
-- the one remaining call site that lives in SQL. Also excludes a
-- soft-deleted workspace from the candidate set — belt-and-braces,
-- matching every other fallback-selection site in this codebase
-- (normally impossible here since a deleted workspace's own members
-- are deactivated by workspace/delete, but there's no reason this
-- one query should be the exception to that defensive pattern).
-- ============================================================

CREATE OR REPLACE FUNCTION public.leave_workspace_atomic(p_workspace_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member_id             uuid;
  v_leaver_admin_capable  boolean;
  v_active_count          int;
  v_other_admin_count     int;
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

  SELECT id, (effective_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean
    INTO v_member_id, v_leaver_admin_capable
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

  IF COALESCE(v_leaver_admin_capable, false) THEN
    SELECT count(*) INTO v_other_admin_count
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active' AND id <> v_member_id
      AND (effective_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean IS TRUE;

    IF v_other_admin_count = 0 THEN
      RAISE EXCEPTION 'sole_admin';
    END IF;
  END IF;

  UPDATE public.workspace_members
  SET status = 'deactivated', deactivated_at = now()
  WHERE id = v_member_id;

  -- If this was the leaving user's active workspace, reassign it to
  -- another workspace they still belong to (same fallback the route
  -- already did — kept here so the whole operation is one transaction).
  --
  -- FIX (migration 065): prefer a workspace that has actually finished
  -- onboarding over one that hasn't, before falling back to oldest-first
  -- among ties — see this migration's header comment.
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

-- ============================================================
-- FEATURE (deep audit, Workspace lifecycle + Onboarding re-pass —
-- feature gap): workspace/delete has never had any symmetric
-- undo. Deletion is soft (workspaces.deleted_at) with a full 7-year
-- retention window before app/api/cron/workspace-purge hard-deletes
-- it — the data sits there, recoverable in principle — but nothing
-- in the product, self-service or admin-facing, can ever bring it
-- back. Every blocked-deletion error message in workspace/delete
-- points at "contact support@scopegov.app" with no actual lever on
-- the other end of that email; the onboarding wizard's own "Discard
-- this workspace" button makes throwing one away a single confirm-
-- dialog click, with the same one-way outcome.
--
-- restore_workspace_atomic gives the ORIGINAL deleter a real,
-- self-service way back, bounded to a 30-day window (generous enough
-- to cover "I didn't mean to," short enough that it isn't a second,
-- unbounded soft-delete state sitting alongside the real one).
-- Deliberately narrow:
--   - only the workspace's CURRENT created_by can restore it (same
--     authority workspace/delete itself requires via
--     MANAGE_WORKSPACE_SETTINGS, and the same identity
--     transfer_workspace_ownership already treats as authoritative);
--   - only within 30 days of deleted_at;
--   - reactivates exactly the workspace_members rows THIS deletion
--     deactivated (matched by the exact deactivated_at timestamp
--     workspace/delete now stamps alongside its own deleted_at — see
--     that route's own comment), never a member who'd genuinely left
--     or been removed before the deletion happened.
-- No project/SOW/CO/invoice/audit data needs any special handling
-- here — deletion never touched any of it (workspace/delete's own
-- guards mean a workspace can only ever BE deleted with no signed
-- SOW, accepted CO, or outstanding invoice in the first place), so
-- un-hiding the workspace and its members is a complete restore.
-- ============================================================

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

  -- Land the restorer straight back in the workspace they just brought
  -- back, rather than wherever the deletion-time reassignment (see
  -- workspace/delete's own comment, and pickFallbackMembership in
  -- lib/auth/session.ts) sent them.
  UPDATE public.users SET active_workspace_id = p_workspace_id WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.restore_workspace_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_workspace_atomic(uuid, uuid) TO service_role;
