-- ============================================================
-- ScopeGov — Migration 046: portal view tracking + invoice dispute
--
-- FEATURE (portal audit, section 18): SOW/CO/Invoice all have a sent_at
-- and each terminal action (signed/declined/accepted/countered) is
-- timestamped, but nothing recorded whether the client had even opened
-- the link in between. Checked the schema directly before writing this —
-- there was no first_viewed_at anywhere, so this isn't a half-wired
-- feature like sow_documents.status='expired' was; it was never started.
-- Adds one column per document type, set once (first view only) by the
-- corresponding portal GET route.
--
-- FEATURE (portal audit, section 18): the invoice portal had no way for a
-- client to push back on an invoice — SOW gets decline + request-changes,
-- CO gets decline + counter, invoice got nothing. Deliberately NOT adding
-- a new invoices.status value for this (the CHECK constraint's existing
-- six states are read/filtered across a lot of the app, and a dispute
-- isn't a lifecycle stage — the invoice is still exactly as sent/overdue/
-- whatever it was, just now also flagged). disputed_at/dispute_note are
-- informational columns alongside status, not a replacement for it.
-- ============================================================

ALTER TABLE public.sow_documents ADD COLUMN IF NOT EXISTS first_viewed_at timestamptz;
ALTER TABLE public.change_orders ADD COLUMN IF NOT EXISTS first_viewed_at timestamptz;
ALTER TABLE public.invoices      ADD COLUMN IF NOT EXISTS first_viewed_at timestamptz;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS disputed_at   timestamptz;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS dispute_note  text;
