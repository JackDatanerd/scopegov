-- 157_default_late_fee_rate.sql
--
-- Workspace late-fee default: a percentage per month charged on overdue amounts. NULL = the agency charges none (and no
-- document says anything about one). It is stated in the SOW's Payment Terms and the rate is frozen into that SOW's
-- metadata at drafting; change orders and invoices print the rate from the SOW they sit under, so changing this setting
-- later never contradicts an already-signed contract.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS default_late_fee_rate numeric(5,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_late_fee_rate_range') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_default_late_fee_rate_range
      CHECK (default_late_fee_rate IS NULL OR (default_late_fee_rate >= 0 AND default_late_fee_rate <= 100));
  END IF;
END $$;
