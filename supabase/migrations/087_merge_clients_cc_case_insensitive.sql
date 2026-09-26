-- FIX (independent pass round 4, section 14): 086 capped merge_clients()'s merged cc_emails
-- array at 10 to match normalizeCcEmails()'s MAX_CC_EMAILS invariant, but its own comment's claim
-- of "dedupe first (DISTINCT), then cap" was never actually true for case: `SELECT DISTINCT e` is
-- an EXACT-STRING comparison in Postgres, not case-insensitive, unlike normalizeCcEmails()
-- (lib/utils/client-input.ts) — the one function every OTHER cc_emails write path in the app goes
-- through, which lowercases every address before deduping. Merging a target with "jane@x.com" in
-- its cc_emails and a source with "Jane@x.com" in its own left BOTH in the merged array: that
-- person then received every future invoice/SOW/CO email for the merged client twice, with no way
-- to notice short of opening the client and counting entries by eye.
--
-- Fix: dedupe on lower(e) instead of e, keeping the FIRST-SEEN casing so precedence is unchanged
-- (target's own cc_emails first, then the source's cc_emails, then the source's own primary email
-- last — same concatenation order 077/086 already used), then cap at 10 exactly as 086 intended.
-- Nothing else in the function changes.
CREATE OR REPLACE FUNCTION public.merge_clients(
  p_workspace_id uuid, p_source uuid, p_target uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_src public.clients%ROWTYPE;
  v_tgt public.clients%ROWTYPE;
  v_projects integer;
  v_contacts integer := 0;
BEGIN
  IF p_source = p_target THEN RAISE EXCEPTION 'same_client'; END IF;
  SELECT * INTO v_src FROM public.clients WHERE id = p_source AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source_not_found'; END IF;
  SELECT * INTO v_tgt FROM public.clients WHERE id = p_target AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'target_not_found'; END IF;

  UPDATE public.projects SET client_id = p_target WHERE client_id = p_source AND workspace_id = p_workspace_id;
  GET DIAGNOSTICS v_projects = ROW_COUNT;

  -- Contacts: keep the target's own; move the source's unless the target already has that email.
  -- Moved contacts never steal the target's primary slot.
  UPDATE public.client_contacts sc
     SET client_id = p_target, is_primary = false
   WHERE sc.client_id = p_source
     AND NOT EXISTS (SELECT 1 FROM public.client_contacts tc
                      WHERE tc.client_id = p_target AND lower(tc.email) = lower(sc.email));
  GET DIAGNOSTICS v_contacts = ROW_COUNT;

  -- The source's primary email becomes a CC on the target (it was a real recipient).
  -- Case-insensitive de-dup (keeping first-seen casing, target-first/source-second/primary-last
  -- precedence preserved via `ord`), then capped at 10 to match normalizeCcEmails()'s
  -- MAX_CC_EMAILS app-level invariant.
  UPDATE public.clients SET cc_emails = (
      SELECT COALESCE(array_agg(e), '{}')
        FROM (
          SELECT e
            FROM (
              SELECT DISTINCT ON (lower(e)) e, ord
                FROM unnest(COALESCE(v_tgt.cc_emails, '{}') || COALESCE(v_src.cc_emails, '{}') || ARRAY[v_src.email])
                     WITH ORDINALITY AS u(e, ord)
               WHERE lower(e) <> lower(v_tgt.email)
               ORDER BY lower(e), ord
            ) deduped
           ORDER BY ord
           LIMIT 10
        ) capped
    ),
    updated_at = now()
  WHERE id = p_target;

  DELETE FROM public.clients WHERE id = p_source;  -- remaining source contacts cascade
  RETURN jsonb_build_object('projects_moved', v_projects, 'contacts_moved', v_contacts,
                            'source_name', v_src.name, 'target_name', v_tgt.name);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_clients(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_clients(uuid, uuid, uuid) TO service_role;
