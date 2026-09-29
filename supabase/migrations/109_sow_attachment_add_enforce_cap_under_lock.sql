-- FIX (independent pass, section 9): MAX_ATTACHMENTS_PER_SOW (20) has only ever been enforced by a
-- plain `SELECT count()` in the API route (app/api/sow/[id]/attachments/route.ts), run BEFORE the
-- file is uploaded and BEFORE the row is inserted, with nothing tying the two together. Two
-- near-simultaneous uploads for the same SOW, both arriving while the count is one under the cap,
-- can each pass that pre-check and each insert — leaving the SOW with 21+ attachments. Same
-- check-then-act shape migration 093 closed for client contacts (client_contact_add).
--
-- The same route also checked `sent_at IS NULL` (the "draft only" lock) as a separate read long
-- before the insert, so an upload racing a send could land a new attachment on a SOW that had just
-- been put out for signature. Both checks now happen here, under one `FOR UPDATE` lock on the
-- sow_documents row: the send path's compare-and-set UPDATE of that row serializes against it, so
-- either the send commits first (we see sent_at and refuse) or we insert first (the send then sees
-- the attachment as part of what it locked).
--
-- The route keeps its own count/sent_at pre-check purely as a cheap fast-path so an obviously
-- doomed upload is refused before its body is buffered and pushed to Storage.
CREATE OR REPLACE FUNCTION public.sow_attachment_add(
  p_sow_id uuid, p_file_name text, p_file_size integer, p_mime_type text,
  p_storage_path text, p_uploaded_by uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sent_at timestamptz;
  v_count integer;
  v_id uuid;
  v_uploaded_at timestamptz;
  v_max_attachments CONSTANT integer := 20; -- MAX_ATTACHMENTS_PER_SOW, app/api/sow/[id]/attachments/route.ts
BEGIN
  SELECT sent_at INTO v_sent_at FROM public.sow_documents WHERE id = p_sow_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sow_not_found';
  END IF;
  IF v_sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'sow_locked';
  END IF;

  SELECT count(*) INTO v_count FROM public.sow_attachments WHERE sow_id = p_sow_id;
  IF v_count >= v_max_attachments THEN
    RAISE EXCEPTION 'attachment_limit_exceeded';
  END IF;

  INSERT INTO public.sow_attachments (sow_id, file_name, file_size, mime_type, storage_path, uploaded_by)
  VALUES (p_sow_id, p_file_name, p_file_size, p_mime_type, p_storage_path, p_uploaded_by)
  RETURNING id, uploaded_at INTO v_id, v_uploaded_at;

  RETURN jsonb_build_object('id', v_id, 'uploaded_at', v_uploaded_at);
END;
$$;

REVOKE ALL ON FUNCTION public.sow_attachment_add(uuid, text, integer, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sow_attachment_add(uuid, text, integer, text, text, uuid) TO service_role;

-- Reference lookup used by the attachment DELETE route: reopen / portal request-changes copy
-- attachment ROWS forward onto a new SOW version while sharing the same Storage object, so
-- storage_path is not unique per row. Index it so "is any other row still using this object?" stays
-- a point lookup instead of a scan over every attachment in the workspace.
CREATE INDEX IF NOT EXISTS sow_attachments_storage_path_idx ON public.sow_attachments (storage_path);
