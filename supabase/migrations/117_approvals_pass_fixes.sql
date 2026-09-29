-- ============================================================
-- 117: approvals section-11 pass fixes
--
-- RUN THIS BEFORE DEPLOYING THE MATCHING CODE (app/api/sow/[id]/attachments,
-- app/api/approval-workflows).
--
--   A. sow_attachment_add also refuses while the SOW has an ACTIVE approval
--      request (pending, or approved-but-not-sent). A SOW inside an approval
--      chain stays status 'draft' with sent_at NULL, so the draft-only lock
--      never applied — approvers sign off on a snapshot and the attachments
--      could change underneath them.
--   B. At most one ACTIVE approval workflow per (workspace, document type,
--      threshold, currency), and one active catch-all per (workspace,
--      document type). The API only ever enforced this with a count() before
--      the insert, so two simultaneous saves could both pass and leave one
--      rule permanently dead. Created only when no duplicates exist today —
--      otherwise a WARNING says what to deactivate first (same approach as
--      migration 069 F4).
-- ============================================================

-- ── A ───────────────────────────────────────────────────────
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

  IF EXISTS (
    SELECT 1 FROM public.approval_requests
    WHERE document_type = 'sow' AND document_id = p_sow_id
      AND (status = 'pending' OR (status = 'approved' AND send_failed_at IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'sow_approval_pending';
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

-- ── B ───────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.approval_workflows
    WHERE is_active AND threshold_amount IS NULL
    GROUP BY workspace_id, document_type HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'approval_workflows_one_active_catchall was NOT created: some workspace has more than one active catch-all workflow for a document type. Deactivate the extras, then re-run: CREATE UNIQUE INDEX approval_workflows_one_active_catchall ON public.approval_workflows(workspace_id, document_type) WHERE is_active AND threshold_amount IS NULL;';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS approval_workflows_one_active_catchall
      ON public.approval_workflows(workspace_id, document_type)
      WHERE is_active AND threshold_amount IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_workflows
    WHERE is_active AND threshold_amount IS NOT NULL
    GROUP BY workspace_id, document_type, threshold_currency, threshold_amount HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'approval_workflows_one_active_threshold was NOT created: some workspace has two active workflows at the same document type, threshold and currency. Deactivate the extras, then re-run: CREATE UNIQUE INDEX approval_workflows_one_active_threshold ON public.approval_workflows(workspace_id, document_type, threshold_currency, threshold_amount) WHERE is_active AND threshold_amount IS NOT NULL;';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS approval_workflows_one_active_threshold
      ON public.approval_workflows(workspace_id, document_type, threshold_currency, threshold_amount)
      WHERE is_active AND threshold_amount IS NOT NULL;
  END IF;
END;
$$;
