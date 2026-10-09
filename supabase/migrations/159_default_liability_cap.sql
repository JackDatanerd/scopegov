-- 159_default_liability_cap.sql
--
-- Optional liability-limit clause for new SOWs. NULL = the agency adds none (the drafting prompt also forbids the model from
-- inventing one). 'fees_paid' = the SOW states a mutual exclusion of indirect damages and caps the Provider's liability at the
-- fees paid under that SOW. The choice is frozen into the SOW's metadata at drafting. Fixed, app-owned wording: not free text.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS default_liability_cap text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_liability_cap_values') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_default_liability_cap_values
      CHECK (default_liability_cap IS NULL OR default_liability_cap IN ('fees_paid'));
  END IF;
END $$;
