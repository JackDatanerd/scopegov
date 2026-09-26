-- FIX (independent pass round 5, section 14 — two findings):
--
-- 1. merge_clients() (077, cc_emails capped in 086/087) moves EVERY one of the source client's
--    client_contacts rows onto the target with no count check at all — unlike cc_emails, which is
--    capped at MAX_CC_EMAILS (10, lib/utils/client-input.ts), client_contacts has an equivalent
--    app-level cap (MAX_CONTACTS_PER_CLIENT = 25, app/api/clients/[id]/contacts/route.ts) that this
--    function has always bypassed entirely. Two clients with, say, 20 contacts each merge into one
--    with 40 — silently past the limit POST /contacts itself refuses to cross by hand, and past
--    what ClientContactsCard's own UI was ever exercised against.
--
--    Fix: compute how much room is left under the cap on the TARGET before moving anything, and
--    move only that many of the source's eligible (non-duplicate-email) contacts, prioritising the
--    ones the app actually uses for something — the primary contact, then role-typed (billing/
--    scope/approver) contacts, then oldest first. Contacts that don't fit are left on the source
--    row and cascade-delete with it, exactly like contacts that were skipped for being duplicate
--    emails already were — no new deletion path, just a second reason the existing one can apply.
--    The count left behind is returned as `contacts_dropped` so the caller can tell the person who
--    merged, rather than the loss being silent.
--
-- 2. Moved contacts are always demoted (`is_primary = false`) so they can never collide with the
--    target's own primary slot — correct when the target already has one. But if the target had
--    NO primary contact of its own, the merge previously left it with zero: the source's primary
--    contact (the one signal withPrimaryContactCc() actually uses for CC routing, independent of
--    the cap above) silently stopped being CC'd on every future invoice/SOW/CO for that client, with
--    nothing anywhere — not the merge confirmation dialog, not the result — saying so.
--
--    Fix: if the source had a primary contact AND it made it across (i.e. wasn't skipped as a
--    duplicate email or dropped by the cap above) AND the target ends up with no primary contact at
--    all, restore its primary flag. This never overrides a primary the target already had.
--
-- Nothing else in the function changes: concatenation order, case-insensitive cc_emails de-dup and
-- its own separate cap (087) are untouched.
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
  v_src_primary_id uuid;
  v_src_primary_moved boolean;
  v_max_contacts CONSTANT integer := 25; -- MAX_CONTACTS_PER_CLIENT, app/api/clients/[id]/contacts/route.ts
BEGIN
  IF p_source = p_target THEN RAISE EXCEPTION 'same_client'; END IF;
  SELECT * INTO v_src FROM public.clients WHERE id = p_source AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source_not_found'; END IF;
  SELECT * INTO v_tgt FROM public.clients WHERE id = p_target AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'target_not_found'; END IF;

  UPDATE public.projects SET client_id = p_target WHERE client_id = p_source AND workspace_id = p_workspace_id;
  GET DIAGNOSTICS v_projects = ROW_COUNT;

  -- Capture the source's primary contact id BEFORE anything moves — this is what lets the
  -- re-promotion check below tell "the source never had a primary" apart from "the source had one
  -- but it didn't make it across" (already a target duplicate, or cut by the cap below).
  SELECT id INTO v_src_primary_id FROM public.client_contacts WHERE client_id = p_source AND is_primary LIMIT 1;

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

  v_src_primary_moved := v_src_primary_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.client_contacts WHERE id = v_src_primary_id AND client_id = p_target);

  IF v_src_primary_moved AND NOT EXISTS (
    SELECT 1 FROM public.client_contacts WHERE client_id = p_target AND is_primary
  ) THEN
    UPDATE public.client_contacts SET is_primary = true WHERE id = v_src_primary_id;
  END IF;

  -- The source's primary email becomes a CC on the target (it was a real recipient). Case-
  -- insensitive de-dup (keeping first-seen casing, target-first/source-second/primary-last
  -- precedence preserved via `ord`), capped at 10 to match normalizeCcEmails()'s MAX_CC_EMAILS
  -- app-level invariant (086/087).
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
                            'contacts_dropped', v_contacts_dropped,
                            'source_name', v_src.name, 'target_name', v_tgt.name);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_clients(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_clients(uuid, uuid, uuid) TO service_role;
