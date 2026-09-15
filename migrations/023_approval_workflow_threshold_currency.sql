-- ============================================================
-- ScopeGov — Migration 023: approval workflow threshold currency
--
-- FIX (re-audit): approval_workflows.threshold_amount was compared
-- directly against a document's raw numeric amount with no currency
-- awareness at all — a workspace-wide "$10,000" threshold applied
-- identically to a $10,000 USD project and a ¥10,000 JPY project
-- (worth roughly $67) or a KSh 10,000 project (worth roughly $77).
-- The builder UI already assumed USD everywhere (hardcoded
-- formatCurrency(..., 'USD'), placeholder copy like "e.g. SOWs over
-- $25k") without ever storing that assumption, so there was no way
-- for the gate evaluator to know what currency a threshold was even
-- denominated in.
--
-- threshold_currency is nullable: NULL means "applies to every
-- document of this type" (i.e. threshold_amount is also NULL — no
-- amount comparison happens at all, so currency is irrelevant and
-- this stays untouched by design, same as the original migration's
-- own comment on threshold_amount). Existing rows that DO have a
-- threshold are backfilled to 'USD', matching the UI's existing
-- baked-in assumption — this doesn't change behavior for anyone
-- whose projects are already USD-denominated, and for anyone who
-- isn't, at least makes the (already-broken) assumption explicit and
-- editable rather than silently wrong.
-- ============================================================

ALTER TABLE public.approval_workflows
  ADD COLUMN IF NOT EXISTS threshold_currency text;

UPDATE public.approval_workflows
  SET threshold_currency = 'USD'
  WHERE threshold_amount IS NOT NULL AND threshold_currency IS NULL;

COMMENT ON COLUMN public.approval_workflows.threshold_currency IS
  'Currency threshold_amount is denominated in. NULL only valid when threshold_amount is also NULL (workflow applies to every document regardless of amount). A thresholded workflow only gates documents in the same currency — see evaluateApprovalGate in lib/approvals/engine.ts.';
