-- ScopeGov — Migration 067: Team & Settings independent-audit round
--
--   1. roles: one name per workspace (case-insensitive) — enforced by the
--      database, not just a racy application check.
--   2. deactivated_member_projects + archive/restore functions: deactivating a
--      member sets their project assignments aside instead of deleting them, and
--      reactivating restores them.
--   3. update_approval_workflow_atomic: editing a workflow (fields + steps) is
--      one transaction, so a failed edit can't leave a half-applied workflow.
--   4. workspace_mfa_status: which members have a verified MFA factor, for the
--      Team roster.

-- ── 1. Role names ──────────────────────────────────────────────────────────
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY workspace_id, lower(btrim(name))
           ORDER BY created_at, id
         ) AS rn
  FROM public.roles
)
UPDATE public.roles r
   SET name = btrim(r.name) || ' (' || ranked.rn || ')',
       updated_at = now()
  FROM ranked
 WHERE r.id = ranked.id
   AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS roles_workspace_name_unique
  ON public.roles (workspace_id, lower(btrim(name)));

-- ── 2. Retained project assignments ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deactivated_member_projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.workspace_members(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  added_at      timestamptz NOT NULL,
  added_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  archived_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, project_id)
);
CREATE INDEX IF NOT EXISTS deactivated_member_projects_member
  ON public.deactivated_member_projects (member_id);

-- Server-only table: RLS on with no policies means only the service role reads it.
ALTER TABLE public.deactivated_member_projects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.archive_member_projects(p_member_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.deactivated_member_projects (workspace_id, member_id, project_id, added_at, added_by)
  SELECT p.workspace_id, pm.member_id, pm.project_id, pm.added_at, pm.added_by
    FROM public.project_members pm
    JOIN public.projects p ON p.id = pm.project_id
   WHERE pm.member_id = p_member_id
  ON CONFLICT (member_id, project_id) DO NOTHING;

  DELETE FROM public.project_members WHERE member_id = p_member_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_member_projects(p_member_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.project_members (project_id, member_id, added_at, added_by)
  SELECT a.project_id, a.member_id, a.added_at, COALESCE(a.added_by, m.user_id)
    FROM public.deactivated_member_projects a
    JOIN public.workspace_members m ON m.id = a.member_id
   WHERE a.member_id = p_member_id
     AND COALESCE(a.added_by, m.user_id) IS NOT NULL
  ON CONFLICT (project_id, member_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM public.deactivated_member_projects WHERE member_id = p_member_id;
  RETURN v_count;
END;
$$;

-- ── 3. Atomic approval-workflow edit ───────────────────────────────────────
-- p_patch holds only the keys to change: name, threshold_amount,
-- threshold_currency, is_active (JSON null clears a nullable field).
-- p_steps: [{ "approverRoleId": uuid|null, "approverUserId": uuid|null }, ...]
CREATE OR REPLACE FUNCTION public.update_approval_workflow_atomic(
  p_workspace_id uuid,
  p_workflow_id  uuid,
  p_patch        jsonb,
  p_set_steps    boolean,
  p_steps        jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_step  jsonb;
  v_order integer := 0;
BEGIN
  PERFORM 1 FROM public.approval_workflows
   WHERE id = p_workflow_id AND workspace_id = p_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_not_found';
  END IF;

  IF p_set_steps THEN
    IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) = 0 THEN
      RAISE EXCEPTION 'steps_required';
    END IF;
  END IF;

  UPDATE public.approval_workflows SET
    name               = CASE WHEN p_patch ? 'name'               THEN p_patch->>'name'                       ELSE name END,
    threshold_amount   = CASE WHEN p_patch ? 'threshold_amount'   THEN (p_patch->>'threshold_amount')::numeric ELSE threshold_amount END,
    threshold_currency = CASE WHEN p_patch ? 'threshold_currency' THEN p_patch->>'threshold_currency'         ELSE threshold_currency END,
    is_active          = CASE WHEN p_patch ? 'is_active'          THEN (p_patch->>'is_active')::boolean       ELSE is_active END,
    updated_at         = now()
  WHERE id = p_workflow_id;

  IF p_set_steps THEN
    DELETE FROM public.approval_workflow_steps WHERE workflow_id = p_workflow_id;
    FOR v_step IN SELECT * FROM jsonb_array_elements(p_steps) LOOP
      v_order := v_order + 1;
      INSERT INTO public.approval_workflow_steps (workflow_id, step_order, approver_role_id, approver_user_id)
      VALUES (
        p_workflow_id, v_order,
        NULLIF(v_step->>'approverRoleId', '')::uuid,
        NULLIF(v_step->>'approverUserId', '')::uuid
      );
    END LOOP;
  END IF;
END;
$$;

-- ── 4. Member MFA status ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.workspace_mfa_status(p_workspace_id uuid)
RETURNS TABLE (user_id uuid, has_mfa boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
STABLE
AS $$
  SELECT m.user_id,
         EXISTS (
           SELECT 1 FROM auth.mfa_factors f
            WHERE f.user_id = m.user_id AND f.status = 'verified'
         ) AS has_mfa
    FROM public.workspace_members m
   WHERE m.workspace_id = p_workspace_id
     AND m.status = 'active'
     AND m.user_id IS NOT NULL;
$$;

-- These run only from server code with the service role.
REVOKE ALL ON FUNCTION public.archive_member_projects(uuid)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_member_projects(uuid)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_approval_workflow_atomic(uuid, uuid, jsonb, boolean, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workspace_mfa_status(uuid)                                      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_member_projects(uuid)                                   TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_member_projects(uuid)                                   TO service_role;
GRANT EXECUTE ON FUNCTION public.update_approval_workflow_atomic(uuid, uuid, jsonb, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.workspace_mfa_status(uuid)                                      TO service_role;
