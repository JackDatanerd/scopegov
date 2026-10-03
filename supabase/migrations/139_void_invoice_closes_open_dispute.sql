-- ============================================================
-- ScopeGov — Migration 139: close client disputes left open on already-void invoices
--
-- BUG (section-12 independent pass): voiding an invoice never touched an open client dispute, and the
-- "Resolve dispute" button is hidden on a void invoice, so the dispute could not be closed from the UI. The
-- red "Client disputed" pill, the registry's Disputed filter and the CSV "Disputed" column kept flagging
-- the invoice forever. POST /api/invoices/[id]/void now closes the dispute in the same write; this
-- backfills invoices voided before that change.
--
-- Data only, idempotent, no schema change. No client email is sent.
-- ============================================================

UPDATE public.invoices
SET dispute_resolved_at      = COALESCE(voided_at, now()),
    dispute_resolution_note  = 'Invoice voided'
WHERE status = 'void'
  AND disputed_at IS NOT NULL
  AND dispute_resolved_at IS NULL;
