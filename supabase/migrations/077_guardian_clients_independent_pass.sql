-- ============================================================
-- ScopeGov — Migration 077: Guardian / Scope governance + Clients independent pass
--
-- Run BEFORE deploying the accompanying code (it reads/writes the new columns and
-- calls the new functions; the code degrades where it can, but a missing column
-- fails the write).
--
--  1. guardian_find_duplicate_check(): pgvector duplicate lookup. The old dedup
--     fetched embeddings through PostgREST, which returns a vector column as the
--     text literal "[0.1,…]"; the in-JS cosine comparison never matched anything.
--  2. guardian_checks.classification_attempts / last_attempt_at: compare-and-swap
--     claim + exponential backoff for retry and the guardian-health sweep.
--  3. Unique (project_id, message_id) for inbound email: Postmark redelivery is
--     idempotent.
--  4. append_scope_deliverables() now bumps project_scope_snapshot.version, so a
--     concurrent scope-adjustment compare-and-swap can no longer overwrite a CO's
--     just-appended deliverables.
--  5. exceptions_log.updated_at / updated_by (exception corrections) + one
--     exception per flag.
--  6. Clients: case-insensitive unique email, atomic contact-primary swap,
--     contact role types (billing / scope / approver), client email-bounce marker,
--     merge_clients().
-- ============================================================

-- ── 1. pgvector duplicate lookup ─────────────────────────────
CREATE OR REPLACE FUNCTION public.guardian_find_duplicate_check(
  p_project_id uuid,
  p_embedding  vector(1536),
  p_threshold  double precision,
  p_since      timestamptz
)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT c.id
    FROM public.guardian_checks c
   WHERE c.project_id   = p_project_id
     AND c.is_duplicate = false
     AND c.embedding IS NOT NULL
     AND c.outcome NOT IN ('pending')
     AND c.created_at  >= p_since
     AND (1 - (c.embedding <=> p_embedding)) > p_threshold
   ORDER BY c.embedding <=> p_embedding ASC
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.guardian_find_duplicate_check(uuid, vector, double precision, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardian_find_duplicate_check(uuid, vector, double precision, timestamptz) TO service_role;

-- ── 2. attempts / backoff ────────────────────────────────────
ALTER TABLE public.guardian_checks
  ADD COLUMN IF NOT EXISTS classification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

-- Sweep lookups: unclassified rows, oldest first.
CREATE INDEX IF NOT EXISTS guardian_checks_unclassified
  ON public.guardian_checks (created_at)
  WHERE outcome = 'pending' AND is_duplicate = false;

-- ── 3. inbound idempotency ───────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS guardian_checks_email_message_id
  ON public.guardian_checks (project_id, (source_metadata->>'message_id'))
  WHERE source = 'email' AND (source_metadata->>'message_id') IS NOT NULL;

-- ── 4. snapshot version bump on CO append ────────────────────
CREATE OR REPLACE FUNCTION public.append_scope_deliverables(
  p_project_id uuid,
  p_added      jsonb,
  p_now        timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.project_scope_snapshot
  SET deliverables    = COALESCE(deliverables, '[]'::jsonb) || p_added,
      last_updated_at = p_now,
      last_updated_by = 'amendment',
      version         = COALESCE(version, 1) + 1
  WHERE project_id = p_project_id;
END;
$$;
REVOKE ALL ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) TO service_role;

-- ── 5. exceptions: corrections + one per flag ────────────────
ALTER TABLE public.exceptions_log
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.users(id);

-- Guarded: only created when no flag already has two exception rows (the old
-- double-submit race could have produced some — those need a human to reconcile first).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.exceptions_log WHERE flag_id IS NOT NULL GROUP BY flag_id HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS exceptions_log_one_per_flag
      ON public.exceptions_log (flag_id) WHERE flag_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'exceptions_log has flags with duplicate exception rows — exceptions_log_one_per_flag NOT created; reconcile duplicates then re-run this statement.';
  END IF;
END $$;

-- ── 6a. clients: case-insensitive email uniqueness ───────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.clients GROUP BY workspace_id, lower(email) HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS clients_workspace_email_lower
      ON public.clients (workspace_id, lower(email));
  ELSE
    RAISE NOTICE 'clients has case-variant duplicate emails — clients_workspace_email_lower NOT created; merge them (Clients page) then re-run this statement.';
  END IF;
END $$;

-- ── 6b. clients: bounce marker + contact roles ───────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS email_bounced_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_bounce_kind text;

ALTER TABLE public.client_contacts
  ADD COLUMN IF NOT EXISTS role_type text NOT NULL DEFAULT 'other';
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS client_contacts_role_type_check;
ALTER TABLE public.client_contacts ADD CONSTRAINT client_contacts_role_type_check
  CHECK (role_type IN ('billing', 'scope', 'approver', 'other'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.client_contacts GROUP BY client_id, lower(email) HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS client_contacts_client_email_lower
      ON public.client_contacts (client_id, lower(email));
  ELSE
    RAISE NOTICE 'client_contacts has duplicate emails within a client — client_contacts_client_email_lower NOT created.';
  END IF;
END $$;

-- ── 6c. atomic contact writes (primary swap in ONE transaction) ──
-- The API used to demote the old primary and then insert/update the new one as separate
-- statements: a failure between them left the client with no primary contact.
CREATE OR REPLACE FUNCTION public.client_contact_add(
  p_client_id uuid, p_name text, p_email text, p_role text, p_role_type text, p_is_primary boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM 1 FROM public.clients WHERE id = p_client_id FOR UPDATE;
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

-- ── 6d. merge two clients atomically ─────────────────────────
-- Moves every project, contact and CC address from p_source to p_target, then deletes the
-- (now empty) source. Returns a summary. Workspace-scoped: both ids must belong to it.
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
  UPDATE public.clients SET cc_emails = (
      SELECT COALESCE(array_agg(DISTINCT e), '{}')
        FROM unnest(COALESCE(v_tgt.cc_emails, '{}') || COALESCE(v_src.cc_emails, '{}') || ARRAY[v_src.email]) AS e
       WHERE lower(e) <> lower(v_tgt.email)
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
