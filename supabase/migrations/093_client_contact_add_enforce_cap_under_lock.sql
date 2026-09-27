-- FIX (independent pass, section 14): MAX_CONTACTS_PER_CLIENT (25) has only ever been enforced by
-- a plain `SELECT count()` in the API route (app/api/clients/[id]/contacts/route.ts), run BEFORE
-- calling this function. client_contact_add() takes a `FOR UPDATE` lock on the parent client row
-- (added for the primary-contact-swap atomicity — see 077) but never re-checked the contact count
-- under that lock. So two near-simultaneous add requests for the same client, both arriving while
-- the count is one under the cap, can each pass the route's pre-check, then serialize through the
-- lock one after another and both insert — leaving the client with 26+ contacts despite the cap.
--
-- merge_clients() (089) already leans on this route's cap as the trusted enforcement point for its
-- own equivalent check ("an equivalent app-level cap ... that this function has always bypassed
-- entirely") without that trusted point itself being race-safe — the same check-then-act pattern
-- this codebase has otherwise closed everywhere else with a lock (scope_adjustments version,
-- guardian_flags status CAS, this same function's primary-swap).
--
-- Fix: recompute the count here, under the lock already taken to serialize concurrent adds for one
-- client, and refuse the insert if it would cross the cap. This makes the limit correct no matter
-- how concurrent calls interleave; the route's own pre-check becomes a cheap fast-path for the
-- common single-request case, not the only thing standing between a client and 26+ contacts.
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

  IF p_is_primary THEN
    UPDATE public.client_contacts SET is_primary = false WHERE client_id = p_client_id AND is_primary;
  END IF;
  INSERT INTO public.client_contacts (client_id, name, email, role, role_type, is_primary)
  VALUES (p_client_id, p_name, p_email, p_role, COALESCE(p_role_type, 'other'), p_is_primary)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.client_contact_add(uuid, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_contact_add(uuid, text, text, text, text, boolean) TO service_role;
