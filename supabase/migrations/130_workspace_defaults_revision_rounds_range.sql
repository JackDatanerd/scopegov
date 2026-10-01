-- 130: workspace_defaults.revision_rounds is bounded to 1-10 (NULL = inherit the workspace-wide default).
--
-- The Settings -> Defaults tab and /api/workspace/defaults used to accept 0-20, but
-- /api/sow/generate replaces anything outside 1-10 with 2 and the New Project form only
-- offers 1-10, so a saved 0 or 11-20 silently produced a SOW promising 2 rounds. The API
-- now enforces 1-10; this clamps rows saved under the old range and pins it in the schema.

UPDATE public.workspace_defaults
   SET revision_rounds = LEAST(GREATEST(revision_rounds, 1), 10)
 WHERE revision_rounds IS NOT NULL
   AND (revision_rounds < 1 OR revision_rounds > 10);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workspace_defaults_revision_rounds_range'
       AND conrelid = 'public.workspace_defaults'::regclass
  ) THEN
    ALTER TABLE public.workspace_defaults
      ADD CONSTRAINT workspace_defaults_revision_rounds_range
      CHECK (revision_rounds IS NULL OR revision_rounds BETWEEN 1 AND 10);
  END IF;
END $$;
