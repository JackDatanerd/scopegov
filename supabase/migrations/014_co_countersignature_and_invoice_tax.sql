-- 014_co_countersignature_and_invoice_tax.sql
-- Doc-completeness audit (Aug 2026): counter-accepted change orders
-- previously went straight from 'countered' to 'accepted' the moment the
-- agency accepted the client's counter-offer — with no client signature
-- ever captured for the negotiated amount (the client's original
-- signature, if any, only ever existed for the pre-counter accept path,
-- which this flow doesn't use). Decision: require the client to
-- countersign at the negotiated total before the CO is legally final.
--
-- New intermediate status: 'awaiting_countersignature'.
--   countered --(agency accepts counter)--> awaiting_countersignature
--   awaiting_countersignature --(client signs)--> accepted

ALTER TABLE public.change_orders DROP CONSTRAINT IF EXISTS change_orders_status_check;
ALTER TABLE public.change_orders ADD CONSTRAINT change_orders_status_check
  CHECK (status IN ('draft','awaiting_response','accepted','declined',
                     'countered','closed','stalled','withdrawn','exception_granted',
                     'awaiting_countersignature'));

-- ── Invoice tax breakdown ────────────────────────────────────────
-- Doc-completeness audit finding #2: invoices had no tax field at all —
-- CO already supports subtotal/tax_rate/tax_inclusive/total, but that
-- breakdown was never carried into the invoice, even though invoices
-- already print the client's VAT number. Mirrors the CO columns exactly
-- so an amendment's tax terms can flow straight into its invoice.
-- `amount` remains the grand total (same role as change_orders.total);
-- `subtotal` is optional and only meaningful when tax_rate > 0 — existing
-- invoices with no tax data are unaffected (subtotal defaults to amount,
-- tax_rate 0).
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS subtotal decimal;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS tax_rate decimal NOT NULL DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS tax_inclusive boolean NOT NULL DEFAULT false;
UPDATE public.invoices SET subtotal = amount WHERE subtotal IS NULL;
