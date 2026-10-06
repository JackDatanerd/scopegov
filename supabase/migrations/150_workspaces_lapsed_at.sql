-- ============================================================
-- ScopeGov — Migration 150: explicit "lapsed" marker (read-only workspaces; no free Solo tier)
--
-- Solo is a paid plan, but an expired trial, a non-payment downgrade and a cancelled subscription whose paid period
-- ended all used to land on Solo with full (capped) write access and no subscription — a free tier by accident.
-- `lapsed_at` marks "no subscription and not comped". getSession() strips every write permission from a lapsed
-- workspace's session (lib/billing/plans.ts LAPSED_KEEP_PERMISSIONS); data, exports, billing and the client portal
-- keep working. Set by cron/payment-overdue when a trial expires, a grace period is enforced or a cancelled period
-- ends; cleared by a new subscription (billing webhook) and by any staff plan change (a comp is not a lapse).
--
-- No column grant is added on purpose: members never read it directly (the session reads it with the service role),
-- and migration 041's whitelist keeps it unreadable/unwritable for the `authenticated` role.
--
-- Backfill: ONLY workspaces whose lapse is unambiguous — Solo, a trial_ends_at in the past (an expired trial keeps
-- the date; every other path to Solo clears it) and no live subscription. Workspaces that reached Solo by
-- non-payment or cancellation before this migration cannot be told apart from a staff comp without parsing the
-- audit history, so they are left as they are (grandfathered) rather than risk locking a comped customer out.
-- ============================================================

ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS lapsed_at timestamptz;

UPDATE public.workspaces w
SET lapsed_at = COALESCE(w.trial_ends_at, now())
WHERE w.lapsed_at IS NULL
  AND w.deleted_at IS NULL
  AND w.plan_tier = 'solo'
  AND w.trial_ends_at IS NOT NULL
  AND w.trial_ends_at < now()
  AND NOT EXISTS (
    SELECT 1 FROM public.billing b
    WHERE b.workspace_id = w.id AND b.paystack_subscription_code IS NOT NULL
  );
