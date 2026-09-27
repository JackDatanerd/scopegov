-- FIX (deep audit, Billing re-pass — independent redo #2): billing.
-- pending_cancel_subscription_code / pending_cancel_email_token (081) are a
-- single nullable SLOT per workspace. subscription.create's write
-- unconditionally OVERWRITES that slot on every plan switch — with either
-- the CURRENT failure's old subscription code, or null when the current
-- disable succeeded.
--
-- Two plan switches in a row, each meant to disable a DIFFERENT previous
-- subscription, where only the second disable actually succeeds: the second
-- write sets the slot back to null (because ITS disable worked), silently
-- erasing the retry record for the FIRST switch's still-undisabled
-- subscription. payment-overdue's step 4c — built specifically to retry
-- this failure mode — never sees that first subscription again; it keeps
-- renewing and charging the customer indefinitely, with no automated path
-- left to stop it. This is exactly the double-billing scenario 081 exists
-- to prevent, one additional switch removed from the case it already
-- handles.
--
-- Replaced with one row per still-unresolved failed disable, so an
-- arbitrary number of them can be tracked and retried independently instead
-- of a single slot that can only ever remember the most recent one.
-- Existing single-slot data is carried forward; the old columns are then
-- dropped so there is exactly one source of truth.

CREATE TABLE IF NOT EXISTS public.billing_pending_subscription_cancels (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- The specific OLD Paystack subscription that still needs disabling —
  -- deliberately never touches billing.paystack_subscription_code, which by
  -- the time this row exists already holds the workspace's current, paying
  -- subscription (same reasoning 081 already documented for the columns
  -- this replaces).
  subscription_code text NOT NULL,
  email_token        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_attempt_at    timestamptz,
  last_error         text,
  UNIQUE (workspace_id, subscription_code)
);
CREATE INDEX IF NOT EXISTS billing_pending_subscription_cancels_workspace
  ON public.billing_pending_subscription_cancels (workspace_id);
ALTER TABLE public.billing_pending_subscription_cancels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_pending_subscription_cancels FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.billing_pending_subscription_cancels TO service_role;

-- Carry forward whatever was sitting in the old single-slot columns so an
-- already-in-flight retry isn't dropped by this migration itself.
INSERT INTO public.billing_pending_subscription_cancels (workspace_id, subscription_code, email_token)
SELECT workspace_id, pending_cancel_subscription_code, pending_cancel_email_token
FROM public.billing
WHERE pending_cancel_subscription_code IS NOT NULL
ON CONFLICT (workspace_id, subscription_code) DO NOTHING;

ALTER TABLE public.billing DROP COLUMN IF EXISTS pending_cancel_subscription_code;
ALTER TABLE public.billing DROP COLUMN IF EXISTS pending_cancel_email_token;
