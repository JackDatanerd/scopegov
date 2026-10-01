-- ============================================================
-- ScopeGov — Migration 134
-- Cron section 17, round 6 (B1): admin restore now re-enables a Paystack subscription only when the SUSPENSION
-- cancelled it, using the same marker workspace/delete uses (billing.cancelled_by_workspace_delete_at, migration 132).
-- admin suspend writes the marker from this release on.
--
-- Backfill: workspaces ALREADY suspended when this ships have no marker, so without this their restore would stop
-- re-enabling the subscription (the safe direction, but a regression from today, where restore resumes any
-- subscription). Mark every currently-suspended workspace that still holds a subscription code — the status quo
-- behaviour for them. (Migration 132's own backfill deliberately excluded admin suspensions.)
--
-- Idempotent. Run AFTER 133.
-- ============================================================

UPDATE public.billing b
SET cancelled_by_workspace_delete_at = w.deleted_at
FROM public.workspaces w
WHERE w.id = b.workspace_id
  AND w.deleted_at IS NOT NULL
  AND w.suspended_by_admin = true
  AND b.paystack_subscription_code IS NOT NULL
  AND b.cancelled_by_workspace_delete_at IS NULL;
