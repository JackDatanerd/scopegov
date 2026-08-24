-- 017_invoice_line_items.sql
-- Doc-quality audit (Aug 2026) — Invoice PDF vs sample: a real invoice
-- routinely bills multiple lines against different bases in one document
-- (a fixed-fee milestone, hourly T&M hours, a reimbursable expense line),
-- but invoices.amount is a single decimal with a single title. There was
-- no way to represent that without three separate invoices, which breaks
-- the "one invoice per milestone/period" mental model the rest of the
-- product uses.
--
-- Additive, zero-migration-risk to existing data: line_items defaults to
-- an empty array, and the PDF/portal renderers treat an empty array as
-- "this invoice predates itemization" and fall back to synthesizing a
-- single line from the existing title+amount — every invoice already in
-- the database keeps rendering exactly as it does today, with nothing to
-- backfill. New invoices can optionally itemize; amount/title remain the
-- source of truth for the total either way (line_items is a presentation
-- breakdown of amount, not a replacement for it — see CHECK below).

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS line_items jsonb NOT NULL DEFAULT '[]';

COMMENT ON COLUMN public.invoices.line_items IS
  'Optional itemized breakdown, same shape as change_orders.line_items: [{description, quantity, rate, total}]. Empty = single-line invoice (title/amount only), matching all pre-existing rows. When present, line item totals should sum to `amount` — enforced in application code at write time (not a DB constraint, since reimbursable/T&M lines can carry a 0 or blank rate), same pattern already used for change_orders.line_items.';
