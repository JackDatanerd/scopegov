-- 161_portfolio_use_and_client_materials.sql
--
-- Two optional workspace defaults for new SOWs, both NULL by default (the SOW says nothing / uses the project start date).
--
-- default_portfolio_use: whether the Provider may show the work in its portfolio. NULL = the SOW states nothing (the drafting step
--   also removes any portfolio/publicity wording the model volunteers: it is a right nobody supplied). 'with_consent' = only with the
--   Client's prior written consent. 'unless_objects' = allowed unless the Client objects in writing. Fixed wording, frozen into the SOW.
-- default_client_materials_days: business days after the project start by which the Client supplies its initial materials
--   (footage, content, assets). NULL or 0 = the start date. Account access is always due on the start date. The model is handed these
--   dates instead of choosing its own (it picked a different deadline on every run).
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS default_portfolio_use text,
  ADD COLUMN IF NOT EXISTS default_client_materials_days integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_portfolio_use_values') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_default_portfolio_use_values
      CHECK (default_portfolio_use IS NULL OR default_portfolio_use IN ('with_consent', 'unless_objects'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_client_materials_days_range') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_default_client_materials_days_range
      CHECK (default_client_materials_days IS NULL OR (default_client_materials_days BETWEEN 0 AND 30));
  END IF;
END $$;
