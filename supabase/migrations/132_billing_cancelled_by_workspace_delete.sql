-- ============================================================
-- ScopeGov — Migration 132
-- Workspace lifecycle independent pass (fresh): restore must only re-enable a Paystack
-- subscription that the workspace DELETE cancelled.
--
-- workspace/restore used to call resumePaystackSubscription for ANY workspace whose billing row
-- held a subscription code. An owner who had already cancelled their plan (billing/cancel ->
-- cancels_at_period_end = true), then deleted and restored the workspace, got the subscription
-- re-enabled and was charged again at the next cycle — a cancellation they asked for was undone.
-- Nothing durable said WHO had cancelled it.
--
-- billing.cancelled_by_workspace_delete_at is set by workspace/delete only when delete itself
-- disabled the subscription (not when it was already non-renewing), and cleared by restore once
-- the subscription is re-enabled.
--
-- Idempotent. Run AFTER 131.
-- ============================================================

ALTER TABLE public.billing
  ADD COLUMN IF NOT EXISTS cancelled_by_workspace_delete_at timestamptz;

-- Backfill for workspaces deleted before this migration and still inside the 30-day restore
-- window: flag those whose delete audit entry says billing was cancelled AND where the owner had
-- not already requested a cancellation before the delete.
UPDATE public.billing b
SET cancelled_by_workspace_delete_at = w.deleted_at
FROM public.workspaces w
WHERE w.id = b.workspace_id
  AND w.deleted_at IS NOT NULL
  AND w.deleted_at > now() - interval '30 days'
  AND w.suspended_by_admin = false
  AND b.paystack_subscription_code IS NOT NULL
  AND b.cancelled_by_workspace_delete_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.audit_log a
    WHERE a.workspace_id = w.id AND a.event_type = 'workspace.deleted'
      AND a.metadata->>'billing_cancelled' = 'true'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.audit_log a
    WHERE a.workspace_id = w.id AND a.event_type = 'billing.plan_changed'
      AND a.metadata->>'action' = 'cancellation_requested'
      AND a.created_at < w.deleted_at
  );
