-- 037_co_lineage_version_uniqueness.sql
--
-- FIX (section-10 re-pass): app/api/co/[id]/revise/route.ts computed the
-- next version as `MAX(version) WHERE project_id = X` — project-wide,
-- with no uniqueness constraint and no retry. That's wrong on two counts:
--
--   1. Race: two concurrent "Revise & resend" requests on the same CO
--      both read the same max, both insert at the same version. Same
--      class of bug migration 031 fixed for sow_documents.
--
--   2. Scoping: unlike a SOW (one evolving document per project), a
--      project can have several independent, concurrently-live CO
--      lineages (e.g. a "design work" ask and a totally unrelated
--      "hosting costs" ask). Every new top-level CO starts at version 1
--      via the column default — POST /api/co never queries anything —
--      so multiple rows legitimately share (project_id, version=1)
--      today. A project-wide unique constraint would be actively wrong:
--      it would reject that normal case. The real fix is to scope both
--      the query and the constraint to the CO's own lineage, not the
--      project.
--
-- root_co_id: NULL means "this row is the root of its own lineage" —
-- every top-level CO created via POST /api/co stays NULL forever, no
-- two-step insert-then-update needed. A revision (created via
-- /revise) sets root_co_id explicitly to its parent's resolved root
-- (COALESCE(parent.root_co_id, parent.id)), so every row in a family
-- resolves to the same value via COALESCE(root_co_id, id) regardless of
-- how many hops deep it is.
ALTER TABLE public.change_orders
  ADD COLUMN IF NOT EXISTS root_co_id uuid REFERENCES public.change_orders(id);

-- Backfill existing revisions. Processing oldest-created-first guarantees
-- each child's parent has already been resolved by the time we reach it,
-- so this converges in a single pass even for chains more than one hop
-- deep (revise -> decline -> revise again).
DO $$
DECLARE
  r RECORD;
  parent_root uuid;
BEGIN
  FOR r IN
    SELECT id, parent_co_id FROM public.change_orders
    WHERE parent_co_id IS NOT NULL
    ORDER BY created_at ASC
  LOOP
    SELECT COALESCE(root_co_id, id) INTO parent_root
    FROM public.change_orders WHERE id = r.parent_co_id;

    UPDATE public.change_orders SET root_co_id = parent_root WHERE id = r.id;
  END LOOP;
END $$;

-- Deduplicate any existing (lineage, version) collisions before adding
-- the constraint — same reasoning as migration 031: renumber onto a
-- fresh trailing version within that lineage rather than deleting,
-- since a duplicate may hold real edits.
DO $$
DECLARE
  dup RECORD;
  next_version integer;
BEGIN
  FOR dup IN
    SELECT id, lineage_root FROM (
      SELECT id, COALESCE(root_co_id, id) AS lineage_root,
             row_number() OVER (
               PARTITION BY COALESCE(root_co_id, id), version
               ORDER BY created_at, id
             ) AS rn
      FROM public.change_orders
    ) ranked
    WHERE rn > 1
    ORDER BY lineage_root, id
  LOOP
    SELECT COALESCE(MAX(version), 0) + 1 INTO next_version
    FROM public.change_orders
    WHERE COALESCE(root_co_id, id) = dup.lineage_root;

    UPDATE public.change_orders SET version = next_version WHERE id = dup.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS change_orders_lineage_version_unique
  ON public.change_orders (COALESCE(root_co_id, id), version);
