-- 031_sow_version_uniqueness.sql
--
-- FIX (section-9 audit, 9-B12): sow_documents had no uniqueness constraint
-- on (project_id, version) at all. Two concurrent "Generate SOW" requests
-- both read "no existing draft", both compute the same
-- `(latestSow?.version || 0) + 1`, and both insert — leaving a project with
-- two rows claiming to be the same version. Downstream, ProjectDetail's
-- `sortedSows[0]` (sorted by version desc) then picks between them
-- nondeterministically, so the agency can send v1-A and later edit v1-B.
--
-- Deduplicate any existing collisions first (keep the oldest row of each
-- colliding pair — that's the one whose id any already-issued token,
-- document number or amendment would reference; renumber the rest onto
-- fresh trailing versions rather than deleting, since a duplicate may
-- legitimately hold edits someone made).
DO $$
DECLARE
  dup RECORD;
  next_version integer;
BEGIN
  FOR dup IN
    SELECT id, project_id
    FROM (
      SELECT id, project_id,
             row_number() OVER (PARTITION BY project_id, version ORDER BY created_at, id) AS rn
      FROM public.sow_documents
    ) ranked
    WHERE rn > 1
    ORDER BY project_id, id
  LOOP
    SELECT COALESCE(MAX(version), 0) + 1 INTO next_version
    FROM public.sow_documents WHERE project_id = dup.project_id;

    UPDATE public.sow_documents SET version = next_version WHERE id = dup.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS sow_documents_project_version_unique
  ON public.sow_documents(project_id, version);
