-- ============================================================
-- ScopeGov — Migration 024: milestone reverse-sync on invoice regression
--
-- FIX (re-audit): sync_milestone_from_invoice() (migration 004) only
-- handled the forward transitions — 'sent' -> milestone 'invoiced',
-- 'paid' -> milestone 'paid'. There was no branch for an invoice's
-- status REGRESSING, e.g. DELETE /api/invoices/[id]/payments/[paymentId]
-- correcting a mis-entered payment that had pushed the invoice to
-- 'paid'. trg_invoice_payments_recalc (migration 004) correctly drops
-- invoices.status back down to 'partially_paid' or 'sent' in that case,
-- but the linked payment_milestones row was never told — it stayed
-- 'paid' forever, permanently out of sync with the invoice it's meant
-- to track.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sync_milestone_from_invoice()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.milestone_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'sent' AND (OLD IS NULL OR OLD.status IS DISTINCT FROM 'sent') THEN
    UPDATE public.payment_milestones
      SET status = 'invoiced', invoiced_at = now()
      WHERE id = NEW.milestone_id AND status IN ('pending','overdue');
  ELSIF NEW.status = 'paid' AND (OLD IS NULL OR OLD.status IS DISTINCT FROM 'paid') THEN
    UPDATE public.payment_milestones
      SET status = 'paid', paid_at = now()
      WHERE id = NEW.milestone_id;
  -- FIX (re-audit): the invoice regressing away from 'paid' (a deleted or
  -- corrected payment) must revert the milestone back to 'invoiced' — it's
  -- no longer actually paid. Only touches a milestone that's currently
  -- 'paid' (same defensive-WHERE style as the branches above), so this
  -- can't clobber a milestone in some other state for an unrelated reason.
  ELSIF OLD IS NOT NULL AND OLD.status = 'paid' AND NEW.status IS DISTINCT FROM 'paid' THEN
    UPDATE public.payment_milestones
      SET status = 'invoiced', paid_at = NULL
      WHERE id = NEW.milestone_id AND status = 'paid';
  END IF;

  RETURN NEW;
END;
$$;
