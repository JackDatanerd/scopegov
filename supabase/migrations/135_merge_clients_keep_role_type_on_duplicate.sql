-- ============================================================
-- ScopeGov — Migration 135: merge_clients keeps a source contact's document routing when the target already has that address
--
-- FIX (independent pass 12, section 14 — B3): a source contact whose email already exists on the target is not moved
-- (the target's copy supersedes it). But `role_type` is what routes mail — billing contacts are CC'd on invoices,
-- scope / approver contacts on SOWs and change orders — so when the source's copy was `billing` and the target's copy of
-- the same address was `other`, the merge silently stopped that person receiving the documents they used to receive.
-- Where the target's copy is `other` and the source's copy is a routing role, the target's copy now takes the source's
-- role_type (the target's own non-`other` role always wins; its name, role label and primary flag are untouched).
--
-- This is 126's function body verbatim except for the single UPDATE marked below.
-- ============================================================

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
  v_live_moved   integer := 0;
  v_reactivated  boolean := false;
BEGIN
  IF p_source = p_target THEN RAISE EXCEPTION 'same_client'; END IF;
  -- FIX (deep audit, section 14 — bug): the two FOR UPDATE locks below used to be taken in
  -- caller-supplied order (source, then target). Two concurrent merges going in opposite
  -- directions between the same pair of clients (A merged into B while B is merged into A) would
  -- lock-order-deadlock: call 1 holds A's lock waiting on B, call 2 holds B's lock waiting on A.
  -- Postgres detects it and aborts one side with a bare deadlock error, surfaced to that user as a
  -- generic "Could not merge the clients." Locking the smaller id first, always, regardless of
  -- which end of the merge it is this call, makes every concurrent pair of merges between the same
  -- two clients take their locks in the same order, so they queue instead of deadlocking.
  IF p_source < p_target THEN
    SELECT * INTO v_src FROM public.clients WHERE id = p_source AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source_not_found'; END IF;
    SELECT * INTO v_tgt FROM public.clients WHERE id = p_target AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'target_not_found'; END IF;
  ELSE
    SELECT * INTO v_tgt FROM public.clients WHERE id = p_target AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'target_not_found'; END IF;
    SELECT * INTO v_src FROM public.clients WHERE id = p_source AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source_not_found'; END IF;
  END IF;

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

  -- FIX (independent pass, section 14 — B1): a merge moved every project into the target whatever the
  -- target's status. PATCH /api/projects/[id] refuses an archived client ("Restore it first") and creating
  -- a project for one reactivates it — merge did neither, so live projects ended up under a client that
  -- stays hidden from the default Clients list. Count the source's live projects first; if any move into
  -- an archived target, the target is reactivated below (same rule project creation applies).
  SELECT count(*) INTO v_live_moved FROM public.projects
   WHERE client_id = p_source AND workspace_id = p_workspace_id
     AND deleted_at IS NULL AND status NOT IN ('Complete', 'Archived');

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

  -- FIX (independent pass 12, section 14 — B3): see the header comment. Runs before the source row is deleted; contacts that
  -- were just moved already belong to the target, so only the duplicate-email source rows are matched here.
  UPDATE public.client_contacts tc
     SET role_type = sc.role_type
    FROM public.client_contacts sc
   WHERE sc.client_id = p_source
     AND tc.client_id = p_target
     AND lower(tc.email) = lower(sc.email)
     AND tc.role_type = 'other'
     AND sc.role_type <> 'other';

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
    status             = CASE WHEN v_tgt.status = 'archived' AND v_live_moved > 0 THEN 'active' ELSE v_tgt.status END,
    updated_at         = now()
  WHERE id = p_target;
  v_reactivated := (v_tgt.status = 'archived' AND v_live_moved > 0);

  DELETE FROM public.clients WHERE id = p_source;  -- remaining source contacts cascade
  RETURN jsonb_build_object('projects_moved', v_projects, 'contacts_moved', v_contacts,
                            'contacts_dropped', v_contacts_dropped, 'cc_dropped', v_cc_dropped,
                            'fields_carried', to_jsonb(v_carried), 'notes_truncated', v_notes_truncated,
                            'source_name', v_src.name, 'target_name', v_tgt.name,
                            'target_reactivated', v_reactivated);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_clients(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_clients(uuid, uuid, uuid) TO service_role;
