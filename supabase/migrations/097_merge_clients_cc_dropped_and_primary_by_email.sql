-- FIX (independent pass round 6, section 14 — two findings, both in merge_clients(), 089):
--
-- 1. The source client's primary email is folded into the target's cc_emails, case-insensitively
--    deduped and capped at 10 (MAX_CC_EMAILS, lib/utils/client-input.ts) — but it's concatenated
--    LAST (target's own cc_emails first, then the source's cc_emails, then the source's own primary
--    email), and the cap keeps the first 10 in that order. So if the target is already at 10 CC
--    addresses, the source's primary email — the whole point of that step, per this function's own
--    comment ("it was a real recipient") — is silently the one dropped, with nothing reported. 089
--    added exactly this kind of visibility for the analogous client_contacts cap
--    (`contacts_dropped`), specifically so contact loss on merge wouldn't be silent, but never
--    applied the same fix to the cc_emails cap sitting right next to it.
--
--    Fix: compute the deduped-but-uncapped cc list first, report how many addresses don't fit under
--    the cap as `cc_dropped`, then cap. Nothing about WHICH addresses are kept changes — same
--    target-first/source-second/primary-last precedence as before — this only makes the loss
--    visible, the same way 089 did for contacts.
--
-- 2. Primary-contact re-promotion (added in 089) only fires when the source's primary contact ROW
--    itself moved to the target (matched by id). If the source's primary contact happens to share
--    its email with an existing NON-primary contact already on the target, that source contact is
--    correctly treated as a duplicate and never moves — so the id-based check never finds it, and a
--    target with no primary contact of its own stays with none, even though the matching address is
--    sitting right there under a different contact row.
--
--    Fix: track the source's primary EMAIL (not just its id) and, when the target ends up with no
--    primary contact, promote whichever target contact — moved or pre-existing — has a
--    case-insensitive match on that email. This subsumes the old id-based check (a moved contact's
--    email always matches itself) so the separate v_src_primary_moved tracking is no longer needed.
--
-- Nothing else in the function changes: project/contact-cap moving logic, case-insensitive cc dedup
-- itself, and the 10-address cap value are all untouched.
CREATE OR REPLACE FUNCTION public.merge_clients(
  p_workspace_id uuid, p_source uuid, p_target uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_src public.clients%ROWTYPE;
  v_tgt public.clients%ROWTYPE;
  v_projects integer;
  v_contacts integer := 0;
  v_contacts_dropped integer := 0;
  v_target_contact_count integer;
  v_room integer;
  v_src_primary_email text;
  v_deduped_cc text[];
  v_cc_dropped integer := 0;
  v_max_contacts CONSTANT integer := 25; -- MAX_CONTACTS_PER_CLIENT, app/api/clients/[id]/contacts/route.ts
  v_max_cc       CONSTANT integer := 10; -- MAX_CC_EMAILS, lib/utils/client-input.ts
BEGIN
  IF p_source = p_target THEN RAISE EXCEPTION 'same_client'; END IF;
  SELECT * INTO v_src FROM public.clients WHERE id = p_source AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source_not_found'; END IF;
  SELECT * INTO v_tgt FROM public.clients WHERE id = p_target AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'target_not_found'; END IF;

  UPDATE public.projects SET client_id = p_target WHERE client_id = p_source AND workspace_id = p_workspace_id;
  GET DIAGNOSTICS v_projects = ROW_COUNT;

  -- Capture the source's primary contact EMAIL before anything moves — used below to re-promote a
  -- primary on the target regardless of whether that address arrives via a moved contact row or was
  -- already sitting on the target under its own row.
  SELECT email INTO v_src_primary_email FROM public.client_contacts WHERE client_id = p_source AND is_primary LIMIT 1;

  SELECT count(*) INTO v_target_contact_count FROM public.client_contacts WHERE client_id = p_target;
  v_room := GREATEST(0, v_max_contacts - v_target_contact_count);

  -- Contacts: keep the target's own; move the source's unless the target already has that email,
  -- capped at the room left under the per-client contact limit. Priority among eligible source
  -- contacts when there isn't room for all of them: the primary contact first (it's what CC routing
  -- actually uses), then role-typed contacts (billing/scope/approver — they route real mail too),
  -- then oldest first. Moved contacts never steal the target's primary slot on the way over.
  WITH eligible AS (
    SELECT sc.id
      FROM public.client_contacts sc
     WHERE sc.client_id = p_source
       AND NOT EXISTS (SELECT 1 FROM public.client_contacts tc
                        WHERE tc.client_id = p_target AND lower(tc.email) = lower(sc.email))
     ORDER BY sc.is_primary DESC, (sc.role_type <> 'other') DESC, sc.created_at ASC
     LIMIT v_room
  )
  UPDATE public.client_contacts sc
     SET client_id = p_target, is_primary = false
    FROM eligible e
   WHERE sc.id = e.id;
  GET DIAGNOSTICS v_contacts = ROW_COUNT;

  -- Whatever is still on the source with no matching target email after the move above is exactly
  -- what the cap left behind (duplicate-email contacts were never "dropped" — they were always
  -- meant to be superseded by the target's own copy, same as before this fix).
  SELECT count(*) INTO v_contacts_dropped
    FROM public.client_contacts sc
   WHERE sc.client_id = p_source
     AND NOT EXISTS (SELECT 1 FROM public.client_contacts tc
                      WHERE tc.client_id = p_target AND lower(tc.email) = lower(sc.email));

  -- FIX (independent pass round 6): re-promote by EMAIL, not by whether the source's primary contact
  -- ROW itself moved — a source primary that was a duplicate of an existing (non-primary) target
  -- contact never moves, but the address is still right there on the target under that other row.
  IF v_src_primary_email IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_contacts WHERE client_id = p_target AND is_primary
  ) THEN
    UPDATE public.client_contacts SET is_primary = true
     WHERE id = (
       SELECT id FROM public.client_contacts
        WHERE client_id = p_target AND lower(email) = lower(v_src_primary_email)
        LIMIT 1
     );
  END IF;

  -- The source's primary email becomes a CC on the target (it was a real recipient). Case-
  -- insensitive de-dup (keeping first-seen casing, target-first/source-second/primary-last
  -- precedence preserved via `ord`), computed BEFORE capping so the cap's toll can be reported.
  SELECT array_agg(e ORDER BY ord) INTO v_deduped_cc
    FROM (
      SELECT DISTINCT ON (lower(e)) e, ord
        FROM unnest(COALESCE(v_tgt.cc_emails, '{}') || COALESCE(v_src.cc_emails, '{}') || ARRAY[v_src.email])
             WITH ORDINALITY AS u(e, ord)
       WHERE lower(e) <> lower(v_tgt.email)
       ORDER BY lower(e), ord
    ) deduped;

  -- FIX (independent pass round 6): this cap silently dropped whatever didn't fit — most often the
  -- source's own primary email, since it's last in concatenation order — with no equivalent to
  -- `contacts_dropped` above. Report it the same way.
  v_cc_dropped := GREATEST(0, COALESCE(array_length(v_deduped_cc, 1), 0) - v_max_cc);

  UPDATE public.clients SET
    cc_emails  = COALESCE(v_deduped_cc[1:v_max_cc], '{}'),
    updated_at = now()
  WHERE id = p_target;

  DELETE FROM public.clients WHERE id = p_source;  -- remaining source contacts cascade
  RETURN jsonb_build_object('projects_moved', v_projects, 'contacts_moved', v_contacts,
                            'contacts_dropped', v_contacts_dropped, 'cc_dropped', v_cc_dropped,
                            'source_name', v_src.name, 'target_name', v_tgt.name);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_clients(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_clients(uuid, uuid, uuid) TO service_role;
