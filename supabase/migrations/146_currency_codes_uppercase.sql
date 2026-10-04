-- ============================================================
-- 146: normalise stored currency codes to upper case (approvals independent pass, B2)
--
-- Approval-workflow thresholds are stored upper-case (the workflow routes upper-case them) and are matched against the
-- document's currency, which comes from projects.currency / invoices.currency. Every current write path upper-cases
-- that value (parseCurrencyCode), but the columns have no constraint, so a row written before that normalisation (or by
-- hand) could read 'usd' — and a thresholded approval rule would then never match it. lib/approvals/pick-workflow.ts now
-- compares case-insensitively; this brings the data in line so every other consumer agrees too.
--
-- Also adds approval_requests.send_failure_alerts (approvals independent pass, B4): how many times the approval-stall cron
-- has told the admins that an approved document still has not been sent. RUN THIS BEFORE DEPLOYING THE MATCHING CODE —
-- the cron's send-failure step selects and filters on the column.
--
-- Safe to run at any time and idempotent: the UPDATEs only touch rows that are not already upper-case and trimmed.
-- ============================================================

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS send_failure_alerts int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.approval_requests.send_failure_alerts IS
  'Times the approval-stall cron has alerted admins that this approved request still has not been sent (capped, see app/api/cron/approval-stall). Not reset by a retry: it counts one incident.';

UPDATE public.projects
SET currency = upper(btrim(currency))
WHERE currency IS NOT NULL AND currency <> upper(btrim(currency));

UPDATE public.invoices
SET currency = upper(btrim(currency))
WHERE currency IS NOT NULL AND currency <> upper(btrim(currency));

UPDATE public.approval_workflows
SET threshold_currency = upper(btrim(threshold_currency))
WHERE threshold_currency IS NOT NULL AND threshold_currency <> upper(btrim(threshold_currency));
