-- FIX (independent pass round 4, section 14 — minor finding): clients has always had a
-- case-SENSITIVE UNIQUE(workspace_id, email) constraint (001_initial_schema), so an exact-string
-- duplicate email race was always caught at the database level regardless of the app's own
-- pre-check. 077 added a case-INSENSITIVE unique index (clients_workspace_email_lower) on top of
-- that — but only for a workspace with no pre-existing case-variant duplicates; for any workspace
-- where that condition failed, 077 only RAISE NOTICE'd and left it uncreated. For exactly those
-- workspaces, POST /api/clients's own ilike pre-check has a TOCTOU window with nothing at the
-- database level to close it: two concurrent "create client" submissions for the same address
-- differing only by case (e.g. "Jane@acme.com" vs "jane@acme.com") could both pass the pre-check
-- and both insert, since the base UNIQUE constraint is exact-string and doesn't consider them the
-- same value.
--
-- An advisory lock, held for the whole of a single transaction, serializes every create/duplicate
-- check for a given (workspace, lower(email)) pair regardless of whether the lower() index exists
-- — it is the backstop for exactly the workspaces that index can't protect. It only helps when the
-- check and the write happen inside the SAME transaction, which a plain supabase-js
-- select-then-insert (two separate calls) never guarantees — hence doing both here, in one RPC,
-- the same shape as client_contact_add / merge_clients (077).
CREATE OR REPLACE FUNCTION public.create_client(
  p_workspace_id uuid, p_name text, p_email text, p_company_name text, p_cc_emails text[],
  p_phone text, p_notes text, p_timezone text, p_billing_address jsonb, p_vat_number text,
  p_payment_terms_note text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing_id   uuid;
  v_existing_name text;
  v_id            uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || lower(p_email), 0));

  SELECT id, name INTO v_existing_id, v_existing_name FROM public.clients
   WHERE workspace_id = p_workspace_id AND lower(email) = lower(p_email)
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'existing_id', v_existing_id, 'existing_name', v_existing_name);
  END IF;

  INSERT INTO public.clients (
    workspace_id, name, email, company_name, cc_emails, phone, notes, timezone,
    billing_address, vat_number, payment_terms_note
  ) VALUES (
    p_workspace_id, p_name, p_email, p_company_name, COALESCE(p_cc_emails, '{}'), p_phone, p_notes,
    p_timezone, p_billing_address, p_vat_number, p_payment_terms_note
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'client_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.create_client(uuid, text, text, text, text[], text, text, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_client(uuid, text, text, text, text[], text, text, text, jsonb, text, text) TO service_role;
