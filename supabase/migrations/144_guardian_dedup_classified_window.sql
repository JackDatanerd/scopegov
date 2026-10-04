-- 144_guardian_dedup_classified_window.sql
--
-- Guardian section 13 (independent pass 11): backlog duplicates were never detected.
--
-- guardian_find_duplicate_check (077) matches only checks whose created_at is >= p_since, and p_since is the later of
-- "30 days ago" and project_scope_snapshot.last_updated_at (pass 10: only checks judged against the CURRENT scope may
-- swallow a new request). But a request that arrives before the SOW is signed is stored `pending` and classified later by
-- the guardian-health sweep - and signing is itself what bumps the snapshot's last_updated_at, to a time AFTER every one
-- of those rows was created. So when the sweep classified the second and third copy of the same forwarded email, the
-- first copy (now classified, against the current scope) was excluded by its creation date and every copy was classified
-- and flagged on its own - the multi-flag / multi-email noise the backlog dedup was added to prevent. The same hit a
-- classification_failed check retried after a re-sign.
--
-- The window is now measured from when a check was JUDGED (classified_at), falling back to created_at for rows that
-- never were. A live check is classified within seconds of being created, so nothing changes for the live paths; a
-- backlog row classified after the last scope change now counts, and a row judged against an older scope still does not.

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
   ORDER BY c.embedding <=> p_embedding ASC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.guardian_find_duplicate_check(uuid, vector, double precision, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardian_find_duplicate_check(uuid, vector, double precision, timestamptz) TO service_role;
