-- FIX (independent pass round 3, section 14): merge_clients() (077) folds the source
-- client's primary email into the target's cc_emails with proper de-duplication, but applied
-- no cap — while every app-level write path (normalizeCcEmails() in lib/utils/client-input.ts)
-- enforces MAX_CC_EMAILS = 10 and rejects a list that exceeds it. A merge was the one write
-- path that bypassed that invariant entirely: it could silently push a client's cc_emails past
-- 10 with no validation, and there was no way back except manually trimming the list afterward
-- (any other field-only PATCH doesn't touch cc_emails, so an over-cap row just sits there).
--
-- Fix: cap the merged array at 10 (oldest/target-first, since v_tgt.cc_emails is listed before
-- v_src.cc_emails and the source's own primary email in the concatenation), matching the
-- app-level invariant. Nothing else in the function changes.
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
  -- Capped at 10 to match normalizeCcEmails()'s MAX_CC_EMAILS app-level invariant: dedupe first
  -- (DISTINCT), then cap (LIMIT applies to the already-deduped rows, so this can't undershoot
  -- by discarding raw duplicates before they'd have collapsed into room for a unique address).
  UPDATE public.clients SET cc_emails = (
      SELECT COALESCE(array_agg(e), '{}')
        FROM (
          SELECT DISTINCT e
            FROM unnest(COALESCE(v_tgt.cc_emails, '{}') || COALESCE(v_src.cc_emails, '{}') || ARRAY[v_src.email]) AS e
           WHERE lower(e) <> lower(v_tgt.email)
           LIMIT 10
        ) deduped
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
