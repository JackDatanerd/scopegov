-- ============================================================
-- ScopeGov — Migration 128: Guardian section 13, independent pass 3 (B2)
--
-- An accepted change order that adds a deliverable the original SOW had explicitly EXCLUDED (the classic
-- "Mobile app — out of scope" that the client later buys) left the title in project_scope_snapshot.out_of_scope
-- forever: append_scope_deliverables() only ever appended to `deliverables`. Guardian then saw the same item as
-- both "accepted CO deliverable" and "explicitly excluded (creepConfidence >= 0.90)". The verdict rules turn a
-- confidently-covered-AND-confidently-creep reply into `borderline` on purpose, so every later message about
-- work the client already paid for raised a human-review item.
--
-- 1. append_scope_deliverables(): also (a) drops exact-title (case/space-insensitive) matches from out_of_scope
--    and (b) skips titles already present in deliverables, so a CO repeating an existing title doesn't
--    duplicate it. Still jsonb[] || jsonb[] (see 045/120 for why), still bumps `version`.
--    remove_scope_deliverables() (100) is the mirror image and already keeps the two lists consistent.
-- 2. DATA REPAIR: strip out_of_scope entries that an accepted amendment later added to the baseline.
--    Same guards as 120's repair: the title must actually be in `deliverables` now; a snapshot re-written by a
--    signing AFTER the amendment is left alone (the newly signed SOW is the baseline); an item a LATER amendment
--    removed again is not touched (remove_scope_deliverables put it back on purpose). Bumps version.
-- ============================================================

CREATE OR REPLACE FUNCTION public.append_scope_deliverables(
  p_project_id uuid,
  p_added      jsonb,
  p_now        timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.project_scope_snapshot s
  SET deliverables = COALESCE(s.deliverables, '{}'::jsonb[])
        || COALESCE((
             SELECT array_agg(n.elem ORDER BY n.ord)
               FROM (
                 SELECT DISTINCT ON (lower(btrim(COALESCE(e.elem->>'title', e.elem #>> '{}'))))
                        e.elem, e.ord
                   FROM jsonb_array_elements(COALESCE(p_added, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
                  WHERE btrim(COALESCE(e.elem->>'title', e.elem #>> '{}')) <> ''
                    AND NOT EXISTS (
                      SELECT 1 FROM unnest(COALESCE(s.deliverables, '{}'::jsonb[])) AS d
                       WHERE lower(btrim(COALESCE(d->>'title', d #>> '{}')))
                           = lower(btrim(COALESCE(e.elem->>'title', e.elem #>> '{}'))))
                  ORDER BY lower(btrim(COALESCE(e.elem->>'title', e.elem #>> '{}'))), e.ord
               ) n
           ), '{}'::jsonb[]),
      out_of_scope = ARRAY(
        SELECT o FROM unnest(COALESCE(s.out_of_scope, '{}'::jsonb[])) AS o
         WHERE lower(btrim(COALESCE(o->>'title', o #>> '{}'))) NOT IN (
           SELECT lower(btrim(COALESCE(x.elem->>'title', x.elem #>> '{}')))
             FROM jsonb_array_elements(COALESCE(p_added, '[]'::jsonb)) AS x(elem)
         )
      ),
      last_updated_at = p_now,
      last_updated_by = 'amendment',
      version         = COALESCE(s.version, 1) + 1
  WHERE s.project_id = p_project_id;
END;
$$;

REVOKE ALL ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) TO service_role;

-- ── data repair ──────────────────────────────────────────────
UPDATE public.project_scope_snapshot s
   SET out_of_scope = ARRAY(
         SELECT o FROM unnest(COALESCE(s.out_of_scope, '{}'::jsonb[])) AS o
          WHERE NOT EXISTS (
            SELECT 1
              FROM public.amendments a
              CROSS JOIN LATERAL unnest(a.added_deliverables) AS t(title)
             WHERE a.project_id = s.project_id
               AND lower(btrim(t.title)) = lower(btrim(COALESCE(o->>'title', o #>> '{}')))
               AND NOT (s.last_updated_by = 'signing' AND s.last_updated_at > a.created_at)
               AND EXISTS (
                 SELECT 1 FROM unnest(COALESCE(s.deliverables, '{}'::jsonb[])) AS d
                  WHERE lower(btrim(COALESCE(d->>'title', d #>> '{}'))) = lower(btrim(t.title)))
               AND NOT EXISTS (
                 SELECT 1 FROM public.amendments a2, unnest(a2.removed_deliverables) AS r
                  WHERE a2.project_id = s.project_id AND a2.created_at > a.created_at
                    AND lower(btrim(r)) = lower(btrim(t.title)))
          )
       ),
       last_updated_at = now(),
       last_updated_by = 'amendment',
       version         = COALESCE(s.version, 1) + 1
 WHERE EXISTS (
   SELECT 1
     FROM unnest(COALESCE(s.out_of_scope, '{}'::jsonb[])) AS o
     JOIN public.amendments a ON a.project_id = s.project_id
     CROSS JOIN LATERAL unnest(a.added_deliverables) AS t(title)
    WHERE lower(btrim(t.title)) = lower(btrim(COALESCE(o->>'title', o #>> '{}')))
      AND NOT (s.last_updated_by = 'signing' AND s.last_updated_at > a.created_at)
      AND EXISTS (
        SELECT 1 FROM unnest(COALESCE(s.deliverables, '{}'::jsonb[])) AS d
         WHERE lower(btrim(COALESCE(d->>'title', d #>> '{}'))) = lower(btrim(t.title)))
      AND NOT EXISTS (
        SELECT 1 FROM public.amendments a2, unnest(a2.removed_deliverables) AS r
         WHERE a2.project_id = s.project_id AND a2.created_at > a.created_at
           AND lower(btrim(r)) = lower(btrim(t.title)))
 );
