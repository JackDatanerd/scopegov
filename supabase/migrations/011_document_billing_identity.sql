-- ============================================================
-- ScopeGov — Phase 11: Document Billing Identity
--
-- Every generated PDF (SOW / CO / Invoice) legally belongs to the
-- agency and their client, not to ScopeGov. Today the PDFs can only
-- print an agency name + logo and a bare client name — no mailing
-- address, no tax ID, no remit-to instructions default, no client
-- billing address surfaced (that column has existed since
-- 001_initial_schema.sql but nothing has ever read or written it).
--
-- This migration adds exactly the fields needed to make an invoice
-- or SOW able to stand on its own as a real business document:
--   - workspaces:  legal_address, tax_id, phone, website,
--                  default_payment_instructions
--   - invoices:    po_number (client-issued purchase order reference)
--
-- clients.billing_address (jsonb) and clients.vat_number (text)
-- already exist and need NO schema change — see the accompanying
-- API/UI changes that finally read and write them.
-- ============================================================

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS legal_address jsonb,                 -- { line1, line2, city, region, postalCode, country }
  ADD COLUMN IF NOT EXISTS tax_id        text,                  -- EIN / VAT / company registration number — label is jurisdiction-dependent, kept freeform
  ADD COLUMN IF NOT EXISTS phone         text,
  ADD COLUMN IF NOT EXISTS website       text,
  ADD COLUMN IF NOT EXISTS default_payment_instructions text;   -- pre-fills invoices.payment_instructions so it isn't retyped per invoice

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS po_number text;                      -- client-issued PO / requisition number, common AP requirement

COMMENT ON COLUMN public.workspaces.legal_address IS
  'Mailing/registered address printed on SOW, CO, and Invoice PDFs. Nullable — documents render without it, just omit the block, so this is safe to ship before every workspace has filled it in.';
COMMENT ON COLUMN public.clients.billing_address IS
  'Printed as the client "Bill To" address on Invoice/SOW/CO PDFs. Existed since 001_initial_schema.sql but had no create/edit surface until Phase 11 — see components/clients and app/api/clients/[id].';
