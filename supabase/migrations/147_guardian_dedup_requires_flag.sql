-- 147_guardian_dedup_requires_flag.sql
--
-- Guardian section 13 (independent pass 13 - B1): a check can only absorb a repeat of its request as a duplicate when
-- its verdict actually reached the team.
--
-- guardian_find_duplicate_check (144) matched any classified check inside the window. An `out_of_scope` / `borderline`
-- verdict recorded with NO flag (a retroactive "log a past check" on a Complete/Archived project is recorded-only) - or
-- whose only flag was closed automatically by "Mark complete" (close_reason 'Project marked complete by <name>', see
-- lib/utils/project-status.ts PROJECT_COMPLETE_CLOSE_PREFIX) - still matched. After the project was reopened (which does
-- not touch the scope snapshot, so the window did not move) the client re-sent the same request and it was marked a
-- duplicate: never classified, no flag, no notification, no email.
--
-- in_scope / covered_by_co verdicts need no flag and match as before. An out_of_scope / borderline verdict now matches
-- only if a guardian_flags row exists for it (guardian_flags_check_id_unique, migration 123, makes that a cheap probe)
-- that was not closed by project completion. A flag a person resolved, closed, escalated or turned into a CO still
-- absorbs repeats - that is a human decision.

CREATE OR REPLACE FUNCTION public.guardian_find_duplicate_check(
  p_project_id uuid,
  p_embedding  vector(1536),
  p_threshold  double precision,
  p_since      timestamptz
)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT c.id
    FROM public.guardian_checks c
   WHERE c.project_id   = p_project_id
     AND c.is_duplicate = false
     AND c.embedding IS NOT NULL
     AND c.outcome NOT IN ('pending')
     AND COALESCE(c.classified_at, c.created_at) >= p_since
     AND (1 - (c.embedding <=> p_embedding)) > p_threshold
     AND (
           c.outcome NOT IN ('out_of_scope', 'borderline')
        OR EXISTS (
             SELECT 1
               FROM public.guardian_flags f
              WHERE f.check_id = c.id
                AND NOT (f.status = 'closed' AND COALESCE(f.close_reason, '') LIKE 'Project marked complete by %')
           )
         )
   ORDER BY c.embedding <=> p_embedding ASC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.guardian_find_duplicate_check(uuid, vector, double precision, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardian_find_duplicate_check(uuid, vector, double precision, timestamptz) TO service_role;
