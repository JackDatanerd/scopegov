-- ============================================================
-- ScopeGov — Migration 036: clean up ghost deactivated-invite rows
--
-- FIX (deep audit, Team & Invites re-pass — CRITICAL, data cleanup):
-- app/api/team/[id]/route.ts's DELETE handler used to soft-deactivate a
-- revoked, never-accepted invite exactly the same way it deactivates a
-- real member — leaving a workspace_members row with status='deactivated'
-- and user_id = NULL. That row rendered as a blank "Unknown" entry in the
-- Deactivated list and offered a "Reactivate" button that, if clicked,
-- produced a phantom "active" member with no account, still consuming a
-- paid seat. The code path is now fixed (revoking a pending invite hard-
-- deletes the row instead), but any workspace that already hit this
-- before the fix shipped is left with orphaned rows sitting in exactly
-- this broken state.
--
-- One other legitimate path produces this same row shape: workspace/
-- delete/route.ts soft-deletes a workspace by setting workspaces.deleted_at
-- and deactivating every member row (including any still-pending invites)
-- so no one can access it afterward — that's an intentional, correct use
-- of status='deactivated' + user_id IS NULL and must NOT be touched here
-- (those workspaces are gone from the UI entirely, so the exploitable
-- "Reactivate" path this migration is cleaning up after was never
-- reachable for them anyway). Scope the cleanup to workspaces that are
-- still live.
-- ============================================================

DELETE FROM public.workspace_members wm
USING public.workspaces w
WHERE wm.workspace_id = w.id
  AND wm.status = 'deactivated'
  AND wm.user_id IS NULL
  AND w.deleted_at IS NULL;
