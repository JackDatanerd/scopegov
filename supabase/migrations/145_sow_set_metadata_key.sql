-- ============================================================
-- ScopeGov — Migration 145
-- SOW lifecycle independent pass 11, B4: atomic single-key write to sow_documents.metadata.
--
-- PATCH /api/sow/[id] (msaReference) and the portal request-changes route (changeRequest on an already-open draft)
-- read the whole metadata object, changed one key in JavaScript and wrote the whole object back. A concurrent
-- write to a different key (the other of those two, or a regenerate carrying the brief) between the read and the
-- write was silently discarded. This merges ONE key inside a single UPDATE — the row lock serialises concurrent
-- callers — and, like sow_apply_section_patch (migration 061), refuses to touch anything that is no longer an
-- unsent draft. Returns true when a row was written.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sow_set_metadata_key(
  p_sow_id uuid, p_key text, p_value jsonb
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
     AND d.sent_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.sow_set_metadata_key(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sow_set_metadata_key(uuid, text, jsonb) TO service_role;
