-- ============================================================
-- 083 — Projects & Dashboard / Portfolio: independent-pass fixes
--
-- FIX (Projects & Dashboard independent pass, finding #1): canReadProject()
-- (lib/utils/project-access.ts) never excluded a soft-deleted project.
--
--   * The VIEW_ALL_PROJECTS branch queries `projects` directly — fixed in
--     application code alongside this migration (adds `deleted_at is null`).
--   * The restricted (VIEW_OWN_PROJECTS) branch queries project_members_active
--     (migration 070), a defense-in-depth view built for exactly this kind of
--     check — but it joined to `projects` only for workspace_id and never
--     excluded a project once its own deleted_at was set. project_members
--     rows are never cleaned up when a project is soft-deleted (only Draft/
--     Intake projects with no signed SOW can be deleted at all — see DELETE
--     /api/projects/[id] — and that route does not touch project_members),
--     so a restricted member who was on the project before deletion kept a
--     permanent, undetectable read grant to it afterward — reachable
--     directly through GET /api/projects/[id]/activity, GET .../messages/
--     unread-count and POST .../messages/read, none of which re-fetch the
--     project scoped to deleted_at is null the way every sibling route does.
--
-- Every other consumer of this view (api/approvals/route.ts, app/(app)/sow/
-- page.tsx, lib/utils/permissions-query.ts, lib/utils/project-messages.ts's
-- listMentionable) has the exact same implicit assumption — "this view only
-- ever names projects the caller can still legitimately reach" — so this is
-- a correctness fix for all of them, not just the three routes that
-- surfaced it.
-- ============================================================

CREATE OR REPLACE VIEW public.project_members_active
WITH (security_invoker = true) AS
SELECT
  pm.id, pm.project_id, pm.member_id, pm.added_at, pm.added_by,
  p.workspace_id  AS project_workspace_id,
  wm.user_id      AS member_user_id
FROM public.project_members pm
JOIN public.projects p          ON p.id  = pm.project_id
JOIN public.workspace_members wm ON wm.id = pm.member_id
WHERE wm.status = 'active'
  AND p.deleted_at IS NULL;

COMMENT ON VIEW public.project_members_active IS
  'project_members filtered to currently-active members of a non-deleted project, with project_workspace_id and member_user_id flattened in. Defense in depth for canReadProject()/filterToProjectAccess() (lib/utils/project-access.ts, lib/utils/permissions-query.ts) and every other reader of "which projects can this restricted user reach" (approvals, SOW list, @mention resolution) — a project''s deleted_at is set once and never cleared, and project_members rows are never cleaned up on delete, so this exclusion is enforced at the read side rather than trusted to a cleanup step that does not exist.';
