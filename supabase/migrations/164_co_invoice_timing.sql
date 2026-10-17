-- 164: when a change order is invoiced. The change order document said only "invoiced separately", so for one-off work added to a
-- retainer neither side could tell whether the invoice comes on acceptance or on delivery. NULL keeps every existing change order
-- exactly as it was (the document then says the invoice follows acceptance, which is the earliest it can be raised).
ALTER TABLE public.change_orders
  ADD COLUMN IF NOT EXISTS invoice_timing text;

ALTER TABLE public.change_orders
  DROP CONSTRAINT IF EXISTS change_orders_invoice_timing_check;
ALTER TABLE public.change_orders
  ADD CONSTRAINT change_orders_invoice_timing_check
  CHECK (invoice_timing IS NULL OR invoice_timing IN ('on_acceptance', 'on_delivery'));
