-- Signatory details printed under signatures on SOW / change-order PDFs.
--   workspaces: who signs for the agency (name + position)
--   sow_documents: the client signer's position and the company they sign on behalf of
-- All nullable and optional; PDFs fall back to the previous behaviour when empty.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS agency_signatory_name  text,
  ADD COLUMN IF NOT EXISTS agency_signatory_title text;
ALTER TABLE public.sow_documents
  ADD COLUMN IF NOT EXISTS signer_title   text,
  ADD COLUMN IF NOT EXISTS signer_company text;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_agency_signatory_len CHECK (
    (agency_signatory_name IS NULL OR char_length(agency_signatory_name) <= 120) AND
    (agency_signatory_title IS NULL OR char_length(agency_signatory_title) <= 120));
ALTER TABLE public.sow_documents
  ADD CONSTRAINT sow_documents_signer_len CHECK (
    (signer_title IS NULL OR char_length(signer_title) <= 120) AND
    (signer_company IS NULL OR char_length(signer_company) <= 160));
