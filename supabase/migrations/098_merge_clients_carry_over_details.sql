-- FIX (independent pass 2, section 14 — feature gap): merge_clients() moved a source client's
-- projects, contacts and CC addresses to the target and then DELETEd the source row — and with it
-- every other field the source carried: billing_address, vat_number, phone, timezone,
-- payment_terms_note, company_name and notes. The duplicate being merged away is very often the
-- record that has the Bill To address (someone filled it in on the client the invoices were actually
-- raised against), so after a merge the moved projects' invoice / SOW / change-order PDFs silently lost
-- their address and VAT number, with nothing on screen saying anything had been dropped.
--
-- The target's own values always win. The source only FILLS GAPS:
--   * company_name, phone, timezone, vat_number, payment_terms_note, billing_address — copied when the
--     target's is NULL / blank;
--   * notes — when both have notes and they differ, the source's are appended under a marker line
--     (capped at 5,000 characters, CLIENT_LIMITS.notes, keeping the target's own text intact); when only
--     the source has notes they are copied.
-- The names of the fields that were actually carried over are returned as `fields_carried`, so the
-- caller can record them in the audit trail. Nothing else in the function changes: project moving,
-- contact-cap/priority logic, primary re-promotion, and CC de-dup/cap are exactly 097's.
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
  v_max_notes    CONSTANT integer := 5000; -- CLIENT_LIMITS.notes, lib/utils/client-input.ts
  v_carried      text[] := '{}';
  v_company      text;
  v_phone        text;
  v_timezone     text;
  v_vat          text;
  v_terms        text;
  v_billing      jsonb;
  v_notes        text;
  v_src_notes    text;
  v_tgt_notes    text;
  v_notes_truncated boolean := false;
BEGIN
  IF p_source = p_target THEN RAISE EXCEPTION 'same_client'; END IF;
  SELECT * INTO v_src FROM public.clients WHERE id = p_source AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source_not_found'; END IF;
  SELECT * INTO v_tgt FROM public.clients WHERE id = p_target AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'target_not_found'; END IF;

  -- Gap-filling carry-over (see the header comment): the target's own value always wins.
  v_company  := v_tgt.company_name;
  v_phone    := v_tgt.phone;
  v_timezone := v_tgt.timezone;
  v_vat      := v_tgt.vat_number;
  v_terms    := v_tgt.payment_terms_note;
  v_billing  := v_tgt.billing_address;
  v_notes    := v_tgt.notes;

  IF NULLIF(btrim(COALESCE(v_company, '')), '') IS NULL AND NULLIF(btrim(COALESCE(v_src.company_name, '')), '') IS NOT NULL THEN
    v_company := v_src.company_name; v_carried := array_append(v_carried, 'company_name');
  END IF;
  IF NULLIF(btrim(COALESCE(v_phone, '')), '') IS NULL AND NULLIF(btrim(COALESCE(v_src.phone, '')), '') IS NOT NULL THEN
    v_phone := v_src.phone; v_carried := array_append(v_carried, 'phone');
  END IF;
  IF NULLIF(btrim(COALESCE(v_timezone, '')), '') IS NULL AND NULLIF(btrim(COALESCE(v_src.timezone, '')), '') IS NOT NULL THEN
    v_timezone := v_src.timezone; v_carried := array_append(v_carried, 'timezone');
  END IF;
  IF NULLIF(btrim(COALESCE(v_vat, '')), '') IS NULL AND NULLIF(btrim(COALESCE(v_src.vat_number, '')), '') IS NOT NULL THEN
    v_vat := v_src.vat_number; v_carried := array_append(v_carried, 'vat_number');
  END IF;
  IF NULLIF(btrim(COALESCE(v_terms, '')), '') IS NULL AND NULLIF(btrim(COALESCE(v_src.payment_terms_note, '')), '') IS NOT NULL THEN
    v_terms := v_src.payment_terms_note; v_carried := array_append(v_carried, 'payment_terms_note');
  END IF;
  IF (v_billing IS NULL OR jsonb_typeof(v_billing) <> 'object' OR v_billing = '{}'::jsonb)
     AND v_src.billing_address IS NOT NULL AND jsonb_typeof(v_src.billing_address) = 'object' AND v_src.billing_address <> '{}'::jsonb THEN
    v_billing := v_src.billing_address; v_carried := array_append(v_carried, 'billing_address');
  END IF;

  v_src_notes := NULLIF(btrim(COALESCE(v_src.notes, '')), '');
  v_tgt_notes := NULLIF(btrim(COALESCE(v_tgt.notes, '')), '');
  IF v_src_notes IS NOT NULL THEN
    IF v_tgt_notes IS NULL THEN
      v_notes := left(v_src_notes, v_max_notes);
      v_notes_truncated := length(v_src_notes) > v_max_notes;
      v_carried := array_append(v_carried, 'notes');
    ELSIF position(v_src_notes in v_tgt_notes) = 0 THEN
      v_notes := v_tgt_notes || E'\n\n— Notes from merged client ' || v_src.name || E' —\n' || v_src_notes;
      v_notes_truncated := length(v_notes) > v_max_notes;
      v_notes := left(v_notes, v_max_notes);
      IF v_notes IS DISTINCT FROM v_tgt.notes THEN v_carried := array_append(v_carried, 'notes'); END IF;
    END IF;
  END IF;

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
    cc_emails          = COALESCE(v_deduped_cc[1:v_max_cc], '{}'),
    company_name       = v_company,
    phone              = v_phone,
    timezone           = v_timezone,
    vat_number         = v_vat,
    payment_terms_note = v_terms,
    billing_address    = v_billing,
    notes              = v_notes,
    updated_at         = now()
  WHERE id = p_target;

  DELETE FROM public.clients WHERE id = p_source;  -- remaining source contacts cascade
  RETURN jsonb_build_object('projects_moved', v_projects, 'contacts_moved', v_contacts,
                            'contacts_dropped', v_contacts_dropped, 'cc_dropped', v_cc_dropped,
                            'fields_carried', to_jsonb(v_carried), 'notes_truncated', v_notes_truncated,
                            'source_name', v_src.name, 'target_name', v_tgt.name);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_clients(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_clients(uuid, uuid, uuid) TO service_role;
