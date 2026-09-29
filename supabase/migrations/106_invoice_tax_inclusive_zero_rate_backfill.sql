-- 106: invoices stored tax_rate = 0 with tax_inclusive = true.
--
-- workspaces.default_tax_inclusive defaults to true (migration 076) independently of
-- default_tax_rate defaulting to 0, so any invoice created without touching the tax
-- fields was stored as "0% tax, inclusive" — contradicting invoices.tax_inclusive's own
-- column default (false). Figures were never affected (grossing-up is skipped at 0%),
-- but the invoice PDF printed a duplicate Subtotal / Amount due pair for these rows.
-- computeInvoiceTotals() now forces the flag false at write time; this cleans history.
-- Presentation-only: amount and subtotal are already equal on every affected row.
UPDATE public.invoices
   SET tax_inclusive = false
 WHERE tax_rate = 0
   AND tax_inclusive = true;
