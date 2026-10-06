-- ============================================================
-- 148: CO attachments - enforce the cap and the draft lock atomically
--
-- RUN THIS BEFORE DEPLOYING THE MATCHING CODE (app/api/co/[id]/attachments).
--
-- MAX_ATTACHMENTS_PER_CO (20) was only ever enforced by a plain count() in the API route, run before the file was
-- uploaded and before the row was inserted. Two near-simultaneous uploads arriving one under the cap both passed it
-- and both inserted (21+ attachments) - the same check-then-act shape migration 109 closed for SOW attachments. The
-- route also read status='draft' and the approval lock as separate reads long before the insert, so an upload racing a
-- send could land a new attachment on a CO that had just gone out.
--
-- All three checks (draft, no active approval, cap) now happen here under one FOR UPDATE lock on the change_orders row.
-- The send path's compare-and-set UPDATE of that row serializes against it: either the send commits first (we see a
-- non-draft status and refuse) or we insert first. The route keeps its own checks purely as a cheap fast-path.
-- ============================================================
CREATE OR REPLACE FUNCTION public.co_attachment_add(
  p_co_id uuid, p_file_name text, p_file_size integer, p_mime_type text,
  p_storage_path text, p_uploaded_by uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
  v_count integer;
  v_id uuid;
  v_uploaded_at timestamptz;
  v_max_attachments CONSTANT integer := 20; -- MAX_ATTACHMENTS_PER_CO, app/api/co/[id]/attachments/route.ts
BEGIN
  SELECT status INTO v_status FROM public.change_orders WHERE id = p_co_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'co_not_found';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'co_locked';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_requests
    WHERE document_type = 'co' AND document_id = p_co_id
      AND (status = 'pending' OR (status = 'approved' AND send_failed_at IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'co_approval_pending';
  END IF;

  SELECT count(*) INTO v_count FROM public.co_attachments WHERE co_id = p_co_id;
  IF v_count >= v_max_attachments THEN
    RAISE EXCEPTION 'attachment_limit_exceeded';
  END IF;

  INSERT INTO public.co_attachments (co_id, file_name, file_size, mime_type, storage_path, uploaded_by)
  VALUES (p_co_id, p_file_name, p_file_size, p_mime_type, p_storage_path, p_uploaded_by)
  RETURNING id, uploaded_at INTO v_id, v_uploaded_at;

  RETURN jsonb_build_object('id', v_id, 'uploaded_at', v_uploaded_at);
END;
$$;

REVOKE ALL ON FUNCTION public.co_attachment_add(uuid, text, integer, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.co_attachment_add(uuid, text, integer, text, text, uuid) TO service_role;

-- "Is any other version's row still using this Storage object?" (the attachment DELETE route) is a point lookup.
CREATE INDEX IF NOT EXISTS co_attachments_storage_path_idx ON public.co_attachments (storage_path);
