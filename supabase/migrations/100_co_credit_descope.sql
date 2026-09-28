-- ============================================================
-- ScopeGov — Migration 100: credit / descope change orders
--
-- FEATURE GAP (CO logic audit): a change order could only ADD scope and money. Negative lines were refused
-- (co-totals.ts), sending required total > 0, and finalize-co recorded removed_deliverables as always-empty,
-- so an agency that agreed to drop a deliverable or refund part of the fee had no governed way to record it.
--
-- is_credit marks a CO whose lines are a reduction. Its line rates and totals are stored NEGATIVE, so every
-- existing consumer that sums amendments.financial_impact (project page, reports, contract-position)
-- already does the right thing. Its line descriptions are the deliverables being removed.
--
-- remove_scope_deliverables() is the counterpart of append_scope_deliverables(): one atomic UPDATE that drops
-- the named deliverables from the Guardian scope baseline and lists them as out of scope, so Guardian starts
-- flagging requests for them again instead of classifying against a baseline that still promises them.
-- ============================================================

ALTER TABLE public.change_orders
  ADD COLUMN IF NOT EXISTS is_credit boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.remove_scope_deliverables(
  p_project_id uuid,
  p_removed    jsonb,
  p_now        timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.project_scope_snapshot s
  SET deliverables = ARRAY(
        SELECT d FROM unnest(COALESCE(s.deliverables, '{}'::jsonb[])) AS d
        WHERE lower(btrim(COALESCE(d->>'title', d #>> '{}'))) NOT IN (
          SELECT lower(btrim(x)) FROM jsonb_array_elements_text(COALESCE(p_removed, '[]'::jsonb)) AS x
        )
      ),
      out_of_scope = COALESCE(s.out_of_scope, '{}'::jsonb[]) || ARRAY(
        SELECT jsonb_build_object('title', x)
        FROM jsonb_array_elements_text(COALESCE(p_removed, '[]'::jsonb)) AS x
        WHERE btrim(x) <> '' AND NOT EXISTS (
          SELECT 1 FROM unnest(COALESCE(s.out_of_scope, '{}'::jsonb[])) AS o
          WHERE lower(btrim(COALESCE(o->>'title', o #>> '{}'))) = lower(btrim(x))
        )
      ),
      last_updated_at = p_now,
      last_updated_by = 'amendment',
      version         = COALESCE(s.version, 1) + 1
  WHERE s.project_id = p_project_id;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_scope_deliverables(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_scope_deliverables(uuid, jsonb, timestamptz) TO service_role;
