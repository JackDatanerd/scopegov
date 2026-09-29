-- FIX (independent pass, section 14 re-audit): PATCH /api/clients/[id]'s email-change duplicate
-- check was a plain select-then-update — an `ilike` pre-check for a case-insensitive duplicate,
-- followed by a SEPARATE `.update()` call. That is the exact TOCTOU shape migration 088's own
-- comment identifies and closes for client CREATION via an advisory-locked RPC (create_client) —
-- "the app's own ilike pre-check has a TOCTOU window with nothing at the database level to close
-- it" — but that fix was only ever applied to POST /api/clients. It was never extended to this
-- edit path, which writes the exact same column under the exact same invariant.
--
-- clients_workspace_email_lower (077) only exists for a workspace that had NO pre-existing
-- case-variant duplicate email at the time that migration ran; for any workspace where it doesn't
-- (unlike client_contacts, `clients` has had real production usage since day one, so this is a
-- realistic condition, not a theoretical one), two concurrent edits — one client's email changed to
-- "Jane@Acme.com", a different client's changed to "jane@acme.com" — could both pass this route's
-- own pre-check and both commit, silently reintroducing the exact case-variant duplicate condition
-- the whole 077→088 lineage exists to prevent.
--
-- update_client_checked() does the duplicate check AND the write inside ONE transaction, under the
-- same advisory lock keyed on (workspace_id, lower(email)) that create_client (088) already uses —
-- so a concurrent create and a concurrent edit for the same address now serialize against each
-- other too, not just against other edits. Takes a jsonb patch (same shape PATCH's own `updates`
-- object already is) rather than typed positional args, matching client_contact_update's (077)
-- established shape for "only touch the columns actually present in the patch" — a plain COALESCE
-- can't distinguish "not sent" from "explicitly cleared to null", which every optional client field
-- (phone, notes, billing_address, ...) needs to support.
CREATE OR REPLACE FUNCTION public.update_client_checked(
  p_client_id uuid, p_workspace_id uuid, p_patch jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_new_email   text;
  v_existing_id uuid;
  v_updated     integer;
BEGIN
  IF jsonb_exists(p_patch, 'email') THEN
    v_new_email := p_patch->>'email';
    -- Same lock create_client (088) takes — serializes every create/duplicate-check/update for a
    -- given (workspace, lower(email)) pair, regardless of whether clients_workspace_email_lower
    -- exists for this workspace.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || lower(v_new_email), 0));
    SELECT id INTO v_existing_id FROM public.clients
     WHERE workspace_id = p_workspace_id AND lower(email) = lower(v_new_email) AND id <> p_client_id
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'existing_id', v_existing_id);
    END IF;
  END IF;

  UPDATE public.clients SET
    name               = CASE WHEN jsonb_exists(p_patch, 'name')               THEN p_patch->>'name'               ELSE name END,
    email              = CASE WHEN jsonb_exists(p_patch, 'email')              THEN p_patch->>'email'              ELSE email END,
    company_name       = CASE WHEN jsonb_exists(p_patch, 'company_name')       THEN p_patch->>'company_name'       ELSE company_name END,
    phone              = CASE WHEN jsonb_exists(p_patch, 'phone')              THEN p_patch->>'phone'              ELSE phone END,
    notes              = CASE WHEN jsonb_exists(p_patch, 'notes')              THEN p_patch->>'notes'              ELSE notes END,
    vat_number         = CASE WHEN jsonb_exists(p_patch, 'vat_number')         THEN p_patch->>'vat_number'         ELSE vat_number END,
    payment_terms_note = CASE WHEN jsonb_exists(p_patch, 'payment_terms_note') THEN p_patch->>'payment_terms_note' ELSE payment_terms_note END,
    timezone           = CASE WHEN jsonb_exists(p_patch, 'timezone')           THEN p_patch->>'timezone'           ELSE timezone END,
    -- NULLIF, not a bare `->`: a cleared address arrives as JSON null, and `->` returns that as the
    -- jsonb VALUE 'null' (not SQL NULL) — harmless everywhere this column is read today (every
    -- caller checks `jsonb_typeof(...) <> 'object'` or falsy-coalesces), but storing real SQL NULL
    -- is the correct representation of "no address", not an incidental one.
    billing_address    = CASE WHEN jsonb_exists(p_patch, 'billing_address')
                               THEN NULLIF(p_patch->'billing_address', 'null'::jsonb)
                               ELSE billing_address END,
    cc_emails          = CASE WHEN jsonb_exists(p_patch, 'cc_emails')
                               THEN COALESCE((SELECT array_agg(e) FROM jsonb_array_elements_text(p_patch->'cc_emails') e), '{}')
                               ELSE cc_emails END,
    status             = CASE WHEN jsonb_exists(p_patch, 'status')             THEN p_patch->>'status'             ELSE status END,
    email_bounced_at   = CASE WHEN jsonb_exists(p_patch, 'email_bounced_at')   THEN (p_patch->>'email_bounced_at')::timestamptz ELSE email_bounced_at END,
    email_bounce_kind  = CASE WHEN jsonb_exists(p_patch, 'email_bounce_kind')  THEN p_patch->>'email_bounce_kind'  ELSE email_bounce_kind END,
    updated_at         = COALESCE((p_patch->>'updated_at')::timestamptz, now())
  WHERE id = p_client_id AND workspace_id = p_workspace_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'updated', v_updated > 0);
END;
$$;
REVOKE ALL ON FUNCTION public.update_client_checked(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_client_checked(uuid, uuid, jsonb) TO service_role;
