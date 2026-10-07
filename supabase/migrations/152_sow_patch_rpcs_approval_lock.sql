-- SOW lifecycle pass 20: sow_apply_section_patch refused only sent drafts. A draft inside an
-- approval chain (pending, or approved-but-send-failed) is also frozen (PATCH route, attachments RPCs since 117/138); the RPCs
-- now enforces it under the row lock too (sow_set_metadata_key is left alone: portal request-changes must still be able to attach a
-- client's note to an open draft), so an autosave racing the approval request cannot change what approvers reviewed.
CREATE OR REPLACE FUNCTION public.sow_apply_section_patch(
  p_sow_id uuid, p_section_id text, p_patch jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.sow_documents d
     SET sections = (
           SELECT jsonb_agg(
                    CASE WHEN e->>'id' = p_section_id THEN e || p_patch ELSE e END
                    ORDER BY ord)
             FROM jsonb_array_elements(d.sections) WITH ORDINALITY AS t(e, ord)
         ),
         updated_at = now()
   WHERE d.id = p_sow_id
     AND d.status = 'draft'
     AND d.sent_at IS NULL
     AND NOT EXISTS (
           SELECT 1 FROM public.approval_requests a
            WHERE a.document_type = 'sow' AND a.document_id = d.id
              AND (a.status = 'pending' OR (a.status = 'approved' AND a.send_failed_at IS NOT NULL)))
     AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(d.sections) x WHERE x->>'id' = p_section_id
         );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.sow_apply_section_patch(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sow_apply_section_patch(uuid, text, jsonb) TO service_role;
