-- ============================================================
-- ScopeGov — Migration 151: heal billing rows left with a payment-failure grace clock after their subscription ended
--
-- Before the trial/subscription-end fix, cron/payment-overdue step 5 (a cancelled subscription whose paid period had
-- already lapsed while a payment failure was in grace) cleared the subscription fields but NOT grace_period_started_at.
-- Such a row — no subscription code, a grace clock still running — would later get a "payment failed, N days left"
-- reminder and, at day 5, a second downgrade, a second `billing.downgraded_for_nonpayment` history entry and a second
-- "could not collect payment" email. The code no longer produces these rows; this clears any that already exist.
-- A grace period only means something while there is a subscription to retry, so it is safe to clear it on every row that
-- has none.
-- ============================================================

UPDATE public.billing
SET grace_period_started_at = NULL, updated_at = now()
WHERE paystack_subscription_code IS NULL
  AND grace_period_started_at IS NOT NULL;
