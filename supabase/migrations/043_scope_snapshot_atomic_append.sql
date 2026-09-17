-- ============================================================
-- ScopeGov — Migration 043: atomic append for scope-snapshot deliverables
--
-- BUG (section-10 audit, CO logic deep pass): lib/documents/finalize-co.ts
-- updates project_scope_snapshot.deliverables on CO acceptance with a
-- plain read-then-write —
--
--   const { data: snap } = ...select('deliverables')...
--   ...update({ deliverables: [...(snap.deliverables||[]), ...added] })
--
-- Two change orders on the SAME project accepted close together (two
-- open portal tabs, or an agency accept-counter landing seconds after a
-- direct client accept on a different CO) race: both read the same
-- starting array, both append their own new deliverables locally, and
-- whichever write lands second silently overwrites the first's addition
-- — the scope snapshot permanently loses one CO's newly-added
-- deliverables with no error anywhere. Not a theoretical edge case: two
-- open change orders on one project resolving close together is a
-- perfectly normal occurrence.
--
-- Fix: push the append into the database as a single atomic statement
-- under a row lock, the same pattern already used for every other
-- concurrent-mutation fix in this codebase (compare-and-swap where a
-- expected-value check is possible, an atomic function where the
-- mutation itself — an array concat — can't be expressed as a CAS).
-- Deliberately narrow: only concatenates the jsonb array, touches
-- nothing else about the snapshot's shape.
-- ============================================================

CREATE OR REPLACE FUNCTION public.append_scope_deliverables(
  p_project_id uuid,
  p_added      jsonb,
  p_now        timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.project_scope_snapshot
  SET deliverables    = COALESCE(deliverables, '[]'::jsonb) || p_added,
      last_updated_at = p_now,
      last_updated_by = 'amendment'
  WHERE project_id = p_project_id;
END;
$$;

REVOKE ALL ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) TO service_role;
