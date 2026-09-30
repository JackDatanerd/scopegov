-- ============================================================
-- ScopeGov — Migration 120: Guardian / scope governance (section 13) independent-pass fixes
--
-- 1. REGRESSION: migration 077 (item 4) re-defined append_scope_deliverables() with the ORIGINAL broken body that
--    migration 045 had fixed. project_scope_snapshot.deliverables is jsonb[]; `COALESCE(deliverables, '[]'::jsonb)
--    || p_added` mixes jsonb[] with jsonb and raises "COALESCE types jsonb[] and jsonb cannot be matched" on every
--    call. finalize-co only logs the RPC error, so since 077 an accepted change order has silently stopped adding
--    its deliverables to the Guardian scope snapshot (the snapshot and its version never move). Restore 045's body
--    (jsonb[] || jsonb[]) — keeping 077's intent of bumping `version` on append, which 045's body also does.
--
-- 2. DATA REPAIR (a): a check that failed classification and was later resolved as a duplicate kept
--    classification_failed = true (the pipeline never cleared it). Those rows show a dead "Retry" button and trip
--    the guardian-health "unresolved failures" alert forever. Clear the flag on every duplicate row.
--
-- 3. DATA REPAIR (b): re-append deliverables from accepted change orders that never reached the snapshot because
--    of (1). Additive and idempotent: only titles missing from the snapshot are appended; a title a LATER
--    amendment removed is not resurrected; a snapshot re-written by a signing AFTER the amendment is left alone
--    (the newly signed SOW is the baseline then). Bumps version so an in-flight scope-adjustment CAS notices.
-- ============================================================

-- ── 1. restore the working function ──────────────────────────
CREATE OR REPLACE FUNCTION public.append_scope_deliverables(
  p_project_id uuid,
  p_added      jsonb,
  p_now        timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.project_scope_snapshot
  SET deliverables    = COALESCE(deliverables, '{}'::jsonb[])
                         || ARRAY(SELECT jsonb_array_elements(COALESCE(p_added, '[]'::jsonb))),
      last_updated_at = p_now,
      last_updated_by = 'amendment',
      version         = COALESCE(version, 1) + 1
  WHERE project_id = p_project_id;
END;
$$;

REVOKE ALL ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) TO service_role;

-- ── 2. duplicates are never "failed" ─────────────────────────
UPDATE public.guardian_checks
   SET classification_failed = false
 WHERE is_duplicate = true AND classification_failed = true;

-- ── 3. re-append deliverables lost to the broken function ────
DO $$
DECLARE
  s RECORD;
  missing jsonb[];
BEGIN
  FOR s IN SELECT id, project_id, deliverables, last_updated_by, last_updated_at FROM public.project_scope_snapshot LOOP
    SELECT COALESCE(array_agg(jsonb_build_object('title', t.title) ORDER BY t.created_at, t.ord), '{}'::jsonb[])
      INTO missing
      FROM (
        SELECT DISTINCT ON (lower(btrim(x.title))) x.title, a.created_at, x.ord
          FROM public.amendments a
          CROSS JOIN LATERAL unnest(a.added_deliverables) WITH ORDINALITY AS x(title, ord)
         WHERE a.project_id = s.project_id
           AND btrim(x.title) <> ''
           -- the snapshot was re-written by a signing after this amendment: the new SOW is the baseline
           AND NOT (s.last_updated_by = 'signing' AND s.last_updated_at > a.created_at)
           -- not already present
           AND NOT EXISTS (
             SELECT 1 FROM unnest(COALESCE(s.deliverables, '{}'::jsonb[])) AS d
              WHERE lower(btrim(COALESCE(d->>'title', d #>> '{}'))) = lower(btrim(x.title)))
           -- not removed by a later amendment
           AND NOT EXISTS (
             SELECT 1 FROM public.amendments a2, unnest(a2.removed_deliverables) AS r
              WHERE a2.project_id = s.project_id AND a2.created_at > a.created_at
                AND lower(btrim(r)) = lower(btrim(x.title)))
         ORDER BY lower(btrim(x.title)), a.created_at, x.ord
      ) t;

    IF array_length(missing, 1) IS NOT NULL THEN
      UPDATE public.project_scope_snapshot
         SET deliverables    = COALESCE(deliverables, '{}'::jsonb[]) || missing,
             last_updated_at = now(),
             last_updated_by = 'amendment',
             version         = COALESCE(version, 1) + 1
       WHERE id = s.id;
    END IF;
  END LOOP;
END $$;
