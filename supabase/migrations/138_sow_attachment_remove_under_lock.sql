-- FIX (SOW lifecycle, round 8, B4): removing a SOW attachment was a plain read-then-delete in
-- app/api/sow/[id]/attachments/[attachmentId]/route.ts: it read sent_at / the approval state, and only afterwards
-- deleted the row. Adding an attachment has been atomic since migration 109 (and 117 for the approval lock) because
-- sow_attachment_add takes a row lock on the SOW and rechecks both conditions under it; the DELETE never got the same
-- treatment, so a delete landing in the gap between a send (or an approval request) and its own write still removed a
-- file from a document that had just been put out or frozen for approval.
--
-- This takes the SAME lock (FOR UPDATE on the sow_documents row), applies the SAME two refusals, scopes the delete to
-- the SOW (an attachment id belonging to a different SOW must not delete), and returns what the route needs to clean
-- up Storage. The route still does the "is another version's row still pointing at this object?" check afterwards.
CREATE OR REPLACE FUNCTION public.sow_attachment_remove(
  p_sow_id uuid, p_attachment_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sent_at timestamptz;
  v_path text;
  v_name text;
BEGIN
  SELECT sent_at INTO v_sent_at FROM public.sow_documents WHERE id = p_sow_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sow_not_found';
  END IF;
  IF v_sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'sow_locked';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_requests
    WHERE document_type = 'sow' AND document_id = p_sow_id
      AND (status = 'pending' OR (status = 'approved' AND send_failed_at IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'sow_approval_pending';
  END IF;

  DELETE FROM public.sow_attachments
   WHERE id = p_attachment_id AND sow_id = p_sow_id
  RETURNING storage_path, file_name INTO v_path, v_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attachment_not_found';
  END IF;

  RETURN jsonb_build_object('storage_path', v_path, 'file_name', v_name);
END;
$$;

REVOKE ALL ON FUNCTION public.sow_attachment_remove(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sow_attachment_remove(uuid, uuid) TO service_role;
