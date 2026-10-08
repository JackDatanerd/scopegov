-- SOW lifecycle pass 24, B2: sow_set_metadata_key (145) refused only sent drafts, so an msaReference autosave racing an approval
-- request could change what approvers reviewed (the reference prints on the PDF masthead). Migration 152 locked sow_apply_section_patch
-- but left this function alone because portal request-changes must still attach a client's note to a draft in an approval chain.
-- The lock is therefore opt-in: the editor's call passes p_enforce_approval_lock = true; the portal call omits it (default false).
DROP FUNCTION IF EXISTS public.sow_set_metadata_key(uuid, text, jsonb);

CREATE OR REPLACE FUNCTION public.sow_set_metadata_key(
  p_sow_id uuid, p_key text, p_value jsonb, p_enforce_approval_lock boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.sow_documents d
     SET metadata   = COALESCE(d.metadata, '{}'::jsonb) || jsonb_build_object(p_key, COALESCE(p_value, 'null'::jsonb)),
         updated_at = now()
   WHERE d.id = p_sow_id
     AND d.status = 'draft'
     AND d.sent_at IS NULL
     AND (NOT p_enforce_approval_lock OR NOT EXISTS (
           SELECT 1 FROM public.approval_requests a
            WHERE a.document_type = 'sow' AND a.document_id = d.id
              AND (a.status = 'pending' OR (a.status = 'approved' AND a.send_failed_at IS NOT NULL))));
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.sow_set_metadata_key(uuid, text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sow_set_metadata_key(uuid, text, jsonb, boolean) TO service_role;
