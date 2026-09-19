-- ============================================================
-- ScopeGov — Migration 053: approval auto-send failure tracking
--
-- FIX (section-11 fix round, flagship finding): when the final step of an
-- approval chain clears, recordApprovalDecision() (lib/approvals/engine.ts)
-- auto-fires the underlying send (sendSowDocument / sendCoDocument /
-- sendInvoiceDocument / acceptCoCounter). If that call fails — a very
-- plausible outcome over a multi-day chain, e.g. the client's email was
-- corrected or removed between the original send request and the final
-- sign-off — the failure was completely invisible everywhere in the
-- product:
--   - approval_requests had no column to even record it (this migration)
--   - notifyRequester's message said the same "approved" text either way
--   - the dashboard's attention query and the stall cron both only ever
--     look at status = 'pending' — the request is now 'approved', so it
--     drops out of every place that would otherwise flag it
-- The document was left silently stuck in 'draft' forever, with an
-- approval history that reads "Approved" and nothing telling anyone it
-- didn't actually go out. The only "recovery" was the requester manually
-- clicking Send again, which silently restarted the ENTIRE chain from
-- step 1 (evaluateApprovalGate has no memory of the prior approval),
-- re-notifying every approver to decide something they'd already decided.
--
-- These two columns let the engine record a failure against the request
-- that's still sitting at status: 'approved' (correctly — the CHAIN did
-- approve; only the mechanical send afterward failed), so it can be
-- surfaced in the UI (ApprovalsClient) and retried directly (see the new
-- /api/approvals/[id]/retry-send route) WITHOUT re-running the approval
-- gate a second time.
-- ============================================================

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS send_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_failed_reason text;

COMMENT ON COLUMN public.approval_requests.send_failed_at IS
  'Set when the auto-send that fires on final approval fails (see recordApprovalDecision). Cleared on a successful retry via /api/approvals/[id]/retry-send. NULL while the request is pending, was rejected/cancelled, or its auto-send succeeded.';
COMMENT ON COLUMN public.approval_requests.send_failed_reason IS
  'Human-readable reason the auto-send failed (from the underlying sendXDocument/acceptCoCounter result), shown to the requester alongside send_failed_at.';

-- Lets the dashboard's attention query and any future cron find these in
-- one indexed scan without touching status at all (a send-failed request
-- can be, and normally is, status = 'approved').
CREATE INDEX IF NOT EXISTS idx_approval_requests_send_failed
  ON public.approval_requests (workspace_id)
  WHERE send_failed_at IS NOT NULL;
