-- 163_client_materials_terms.sql
--
-- One optional workspace default for new SOWs, NULL by default (the SOW says nothing about it).
--
-- default_client_materials_terms: 'standard' adds fixed, app-written wording about the materials the Client supplies (footage, content,
--   assets): the Client confirms it holds the rights and consents needed for the Provider to edit and publish them and gives the
--   Provider a licence to use them for the services, and, on a retainer, what happens to a recurring deliverable when the Client does
--   not supply what it depends on in time. NULL = the SOW states neither. Frozen into the SOW at drafting.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS default_client_materials_terms text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_client_materials_terms_values') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_default_client_materials_terms_values
      CHECK (default_client_materials_terms IS NULL OR default_client_materials_terms IN ('standard'));
  END IF;
END $$;
