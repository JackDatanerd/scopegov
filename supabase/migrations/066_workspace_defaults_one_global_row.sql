-- ScopeGov — Migration 066: exactly one workspace-wide row in workspace_defaults
--
-- UNIQUE (workspace_id, project_type) does not stop duplicates when
-- project_type IS NULL (NULLs are distinct), so two saves of the workspace-wide
-- defaults racing each other could each insert a "global" row. Once two exist,
-- `.maybeSingle()` reads error out and every later save inserted another one.
--
-- 1. Keep the most recently updated workspace-wide row per workspace.
-- 2. Make the invariant structural with a partial unique index.

DELETE FROM public.workspace_defaults d
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY workspace_id
           ORDER BY updated_at DESC, created_at DESC, id
         ) AS rn
  FROM public.workspace_defaults
  WHERE project_type IS NULL
) ranked
WHERE d.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_defaults_one_global
  ON public.workspace_defaults (workspace_id)
  WHERE project_type IS NULL;
