-- ============================================================
-- ScopeGov — Migration 119: client contact duplicate-email check moved under the client row lock
--
-- FIX (independent pass 1, section 14 — B4): POST/PATCH /api/clients/[id]/contacts[/contactId] look for
-- an existing contact with the same email using an unlocked `ilike` SELECT, and only THEN call
-- client_contact_add / client_contact_update, which take FOR UPDATE on the parent client row. Two
-- concurrent requests can both pass the pre-check and then serialize through the lock and both write.
-- The case-insensitive unique index client_contacts_client_email_lower (077) closes that — but only
-- for workspaces where it could be created (it is skipped when a client already had case-variant
-- duplicate contacts). clients got the same treatment in 088 / 108.
--
-- Both functions now re-check under the lock and raise 23505 with a message containing "email", which
-- the routes already map to "A contact with this email already exists for this client." The routes'
-- own pre-check stays as the fast path that names the existing contact.
--
-- client_contact_add keeps 093's cap check verbatim; client_contact_update keeps 077's body verbatim
-- apart from the new duplicate check (only when the patch changes the email).
-- ============================================================

CREATE OR REPLACE FUNCTION public.client_contact_add(
  p_client_id uuid, p_name text, p_email text, p_role text, p_role_type text, p_is_primary boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_count integer;
  v_max_contacts CONSTANT integer := 25; -- MAX_CONTACTS_PER_CLIENT, app/api/clients/[id]/contacts/route.ts
BEGIN
  PERFORM 1 FROM public.clients WHERE id = p_client_id FOR UPDATE;

  SELECT count(*) INTO v_count FROM public.client_contacts WHERE client_id = p_client_id;
  IF v_count >= v_max_contacts THEN
    RAISE EXCEPTION 'contact_limit_exceeded';
  END IF;

  IF EXISTS (SELECT 1 FROM public.client_contacts WHERE client_id = p_client_id AND lower(email) = lower(p_email)) THEN
    RAISE EXCEPTION 'contact_email_exists' USING ERRCODE = '23505';
  END IF;

  IF p_is_primary THEN
    UPDATE public.client_contacts SET is_primary = false WHERE client_id = p_client_id AND is_primary;
  END IF;
  INSERT INTO public.client_contacts (client_id, name, email, role, role_type, is_primary)
  VALUES (p_client_id, p_name, p_email, p_role, COALESCE(p_role_type, 'other'), p_is_primary)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.client_contact_update(
  p_client_id uuid, p_contact_id uuid, p_patch jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM 1 FROM public.clients WHERE id = p_client_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.client_contacts WHERE id = p_contact_id AND client_id = p_client_id) THEN
    RETURN false;
  END IF;
  IF jsonb_exists(p_patch, 'email') AND EXISTS (
    SELECT 1 FROM public.client_contacts
     WHERE client_id = p_client_id AND id <> p_contact_id AND lower(email) = lower(p_patch->>'email')
  ) THEN
    RAISE EXCEPTION 'contact_email_exists' USING ERRCODE = '23505';
  END IF;
  IF (jsonb_exists(p_patch, 'is_primary')) AND (p_patch->>'is_primary')::boolean THEN
    UPDATE public.client_contacts SET is_primary = false
     WHERE client_id = p_client_id AND is_primary AND id <> p_contact_id;
  END IF;
  UPDATE public.client_contacts SET
    name       = CASE WHEN jsonb_exists(p_patch, 'name')      THEN p_patch->>'name'      ELSE name END,
    email      = CASE WHEN jsonb_exists(p_patch, 'email')     THEN p_patch->>'email'     ELSE email END,
    role       = CASE WHEN jsonb_exists(p_patch, 'role')      THEN p_patch->>'role'      ELSE role END,
    role_type  = CASE WHEN jsonb_exists(p_patch, 'role_type') THEN p_patch->>'role_type' ELSE role_type END,
    is_primary = CASE WHEN jsonb_exists(p_patch, 'is_primary') THEN (p_patch->>'is_primary')::boolean ELSE is_primary END
  WHERE id = p_contact_id AND client_id = p_client_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.client_contact_add(uuid, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.client_contact_update(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_contact_add(uuid, text, text, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.client_contact_update(uuid, uuid, jsonb) TO service_role;
