-- 162: a retainer's kind of work.
--
-- A retainer is a way of BILLING (same fee every month), not a kind of work, but it lived in the same
-- column (projects.type) as Web / Marketing / Video. A social-media retainer therefore had to be a
-- "retainer" and lost everything the agency saved for Marketing work (standard out-of-scope clauses,
-- revision policy, assumptions). work_type records the kind of work for a retainer; it is NULL for every
-- other project (their type already says it) and for retainers where nobody said.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS work_type text;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_work_type_check;
ALTER TABLE projects ADD CONSTRAINT projects_work_type_check
  CHECK (work_type IS NULL OR work_type IN ('web','mobile','brand','ecomm','marketing','video','other'));

-- only a retainer carries one
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_work_type_retainer_only;
ALTER TABLE projects ADD CONSTRAINT projects_work_type_retainer_only
  CHECK (work_type IS NULL OR type = 'retainer');
