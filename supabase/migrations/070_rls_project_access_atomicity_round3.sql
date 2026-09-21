-- ============================================================
-- ScopeGov — Migration 070: RLS+permissions independent re-audit (round 3)
--
-- Finding: DELETE /api/team/[id] deactivates a member and archives their
-- project_members rows as TWO SEPARATE network round-trips —
--   1. UPDATE workspace_members SET status = 'deactivated' ...
--   2. SELECT archive_member_projects(id)   (a second, independent call)
-- If step 2 fails for any reason (a transient DB error, a timeout), step 1
-- has already committed and is never rolled back — the route's own comment
-- said so explicitly: "member is deactivated regardless." Nothing retries
-- step 2 and nothing sweeps for orphaned project_members rows afterward.
--
-- That would only be a cosmetic bookkeeping gap EXCEPT that the two
-- functions this app actually uses to decide "can this session read this
-- project" — canReadProject() and filterToProjectAccess(), both in
-- application code — join project_members -> workspace_members filtering
-- only on user_id, never on workspace_members.status = 'active' (every
-- other query touching workspace_members in this codebase filters status).
-- So a failure in step 2 isn't a race window, it's a PERMANENT, SILENT
-- authorization leak: a removed employee keeps full read access to every
-- project they were on, indefinitely, through an app that believes it cut
-- them off.
--
-- Two independent fixes, matching the two independent weaknesses:
--   A. deactivate_member_atomic() — the status flip and the project-
--      membership archive now happen in ONE transaction. If archiving
--      fails, the status flip rolls back too: the admin sees a real error
--      and can retry, instead of a silent, undetectable half-deactivation.
--   B. Defense in depth at the read side itself: project_members_active, a
--      view that joins in workspace_members and filters status = 'active',
--      replaces the raw table in both canReadProject() and
--      filterToProjectAccess() (app-code change, ships with this
--      migration). Even if some future code path ever deactivates a member
--      without going through (A) — or a currently-unknown one already does
--      — a stale project_members row can no longer grant a read.
-- ============================================================

-- ── B. status-defensive read view ───────────────────────────
-- project_members joined out to the two columns canReadProject() and
-- filterToProjectAccess() actually need (the project's workspace_id, the
-- member's user_id), restricted to rows whose member is currently active.
-- Columns are flattened rather than embedded on purpose: PostgREST's nested
-- `table!inner(...)` embedding syntax resolves through declared foreign
-- keys, which a plain view doesn't carry for its underlying tables — a view
-- built to be queried with that syntax is not guaranteed to work. Flat
-- columns need no FK introspection at all, so this is safe regardless of
-- how PostgREST resolves (or fails to resolve) embedding through views.
-- security_invoker so it runs with the caller's own privileges/RLS, not the
-- view owner's — it adds no privilege of its own, it only ever narrows what
-- project_members/projects/workspace_members already permit.
CREATE OR REPLACE VIEW public.project_members_active
WITH (security_invoker = true) AS
SELECT
  pm.id, pm.project_id, pm.member_id, pm.added_at, pm.added_by,
  p.workspace_id  AS project_workspace_id,
  wm.user_id      AS member_user_id
FROM public.project_members pm
JOIN public.projects p          ON p.id  = pm.project_id
JOIN public.workspace_members wm ON wm.id = pm.member_id
WHERE wm.status = 'active';

COMMENT ON VIEW public.project_members_active IS
  'project_members filtered to currently-active members, with project_workspace_id and member_user_id flattened in. Defense in depth for canReadProject()/filterToProjectAccess() (lib/utils/project-access.ts, lib/utils/permissions-query.ts) — the actual invariant "project_members has no rows for a deactivated member" is enforced procedurally by deactivate_member_atomic() below, not by a constraint on the table itself, so the read side checks it again independently rather than trusting that invariant blindly.';

-- No table grants exist for `authenticated` on project_members (locked down
-- since migration 041 and confirmed clean by tests/pg-replay.test.ts), and
-- this view is read only through the service_role client exactly like the
-- table it wraps — same grant posture, nothing new to lock down.

-- ── A. atomic deactivate + archive ──────────────────────────
-- Returns true on success, false when the member row wasn't found in
-- exactly the state DELETE /api/team/[id] already checked for before
-- calling this (workspace_id match + status = 'active') — the same
-- optimistic-concurrency guard the two-step version had, just evaluated
-- inside the transaction instead of in a separate prior SELECT.
CREATE OR REPLACE FUNCTION public.deactivate_member_atomic(
  p_member_id    uuid,
  p_workspace_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  UPDATE public.workspace_members
  SET status = 'deactivated', deactivated_at = v_now
  WHERE id = p_member_id AND workspace_id = p_workspace_id AND status = 'active';

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Same transaction: if this raises, the status flip above rolls back too.
  -- A caller finding out the deactivation failed and can be retried is far
  -- safer than a deactivation that silently "succeeded" while leaving the
  -- person's project access in place — see this migration's header note.
  PERFORM public.archive_member_projects(p_member_id);

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.deactivate_member_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_member_atomic(uuid, uuid) TO service_role;
