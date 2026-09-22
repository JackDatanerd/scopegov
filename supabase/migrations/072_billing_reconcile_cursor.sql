-- ScopeGov — Migration 072: dedicated "last checked" cursor for billing reconciliation
--
-- FIX (cron audit, section 17 re-pass — starvation bug): api/cron/billing-reconcile
-- selects its daily BATCH=200 by `.order('updated_at', ascending).limit(200)`, but
-- `updated_at` is only touched when the row's `updates` object is non-empty — i.e.
-- only when a drift is actually repaired (see the route's own `updates.updated_at`
-- write). A row that's checked and found to already match Paystack never gets its
-- `updated_at` bumped. Once there are more than 200 live subscriptions, the same
-- oldest ~200 (by original `updated_at`) get re-selected and re-checked every single
-- day, and everything past that boundary is never reconciled again — silently,
-- forever, with a green heartbeat every time. `last_reconciled_at` is a cursor
-- dedicated to "was this row checked," bumped on every check regardless of outcome,
-- so the batch selection actually rotates through the whole table over time instead
-- of getting stuck on the same head.
ALTER TABLE public.billing
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;

COMMENT ON COLUMN public.billing.last_reconciled_at IS
  'Set by api/cron/billing-reconcile on every check (repaired or not). Batch selection orders by this, oldest/never-checked first, so the daily reconciliation rotates through every subscription instead of starving on rows past the batch size.';

-- Existing rows have never been "checked" by this cursor — nulls sort first with
-- nullsFirst so they're picked up ahead of anything with a real timestamp, same as
-- a brand-new row would be.
CREATE INDEX IF NOT EXISTS idx_billing_last_reconciled_at
  ON public.billing (last_reconciled_at ASC NULLS FIRST);
