-- 141_admin_panel_hardening.sql
--
-- Platform admin panel, independent audit round 1.
--
--  1. users.suspended_by_admin / suspended_by_admin_at
--     users.deleted_at is shared by THREE different things: an admin suspension, the person's own
--     self-service account deletion, and (after 30 days) erased accounts. Admin "Restore account" could not tell
--     them apart, so it could undo a deliberate self-deletion, and the invite-cleanup cron anonymized an
--     admin-suspended user after 30 days exactly as if they had deleted themselves (workspaces already have
--     the equivalent flag since migration 091). No backfill is possible: admin user suspensions made before
--     this migration never wrote their audit row (the route threw first), so they are indistinguishable from
--     self-deletions and stay `false`; restoring one now requires an explicit confirmation in the panel.
--     users has no UPDATE grant for `authenticated` (migration 068), so no new grant is needed.
--
--  2. admin_workspace_plan_counts()  - GROUP BY in SQL. The Overview page selected every workspace row and counted
--     in JS, which PostgREST silently truncates at 1000 rows.
--
--  3. admin_finance_summary(p_months) - monthly collected / refunded / failed / disputed totals per currency,
--     read from the audit_log rows the Paystack webhook already writes (billing.payment_succeeded etc.). Amounts
--     are summed per currency, never across currencies.
--
--  4. A partial index on audit_log(event_type, created_at) for billing events so (3) and the admin recent-payments
--     feed do not scan the whole table.  (Plain CREATE INDEX: migrations run in a transaction, so CONCURRENTLY is
--     not available - on a very large audit_log, create it by hand first.)

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS suspended_by_admin    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended_by_admin_at timestamptz;

CREATE INDEX IF NOT EXISTS audit_log_billing_event_created
  ON public.audit_log (event_type, created_at DESC)
  WHERE event_type LIKE 'billing.%';

CREATE OR REPLACE FUNCTION public.admin_workspace_plan_counts()
RETURNS TABLE(plan_tier text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.plan_tier::text, count(*)::bigint
  FROM public.workspaces w
  WHERE w.deleted_at IS NULL
  GROUP BY w.plan_tier
$$;

CREATE OR REPLACE FUNCTION public.admin_finance_summary(p_months int DEFAULT 12)
RETURNS TABLE(month date, currency text, kind text, n bigint, total numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    date_trunc('month', a.created_at AT TIME ZONE 'UTC')::date AS month,
    COALESCE(NULLIF(upper(a.metadata->>'currency'), ''), '?')   AS currency,
    CASE a.event_type
      WHEN 'billing.payment_succeeded'    THEN 'payment'
      WHEN 'billing.refund_processed'     THEN 'refund'
      WHEN 'billing.charge_dispute_create' THEN 'dispute'
      ELSE 'failed'
    END AS kind,
    count(*)::bigint AS n,
    COALESCE(sum(CASE WHEN a.metadata->>'amount' ~ '^[0-9]+(\.[0-9]+)?$'
                      THEN (a.metadata->>'amount')::numeric END), 0) AS total
  FROM public.audit_log a
  WHERE a.event_type IN (
          'billing.payment_succeeded', 'billing.refund_processed', 'billing.charge_dispute_create',
          'billing.payment_failed_grace_started', 'billing.payment_retry_failed')
    AND a.created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC')
                         - make_interval(months => LEAST(GREATEST(p_months, 1), 36) - 1)) AT TIME ZONE 'UTC'
  GROUP BY 1, 2, 3
  ORDER BY 1 DESC, 2, 3
$$;

REVOKE ALL ON FUNCTION public.admin_workspace_plan_counts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_finance_summary(int)    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_workspace_plan_counts() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_finance_summary(int)    TO service_role;
