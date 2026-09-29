-- ============================================================
-- ScopeGov — Migration 114: milestone reverse-sync — regression branch must run first
--
-- BUG (section-12 independent pass): migration 024 added a branch to
-- sync_milestone_from_invoice() that reverts a milestone from 'paid' to
-- 'invoiced' when its invoice regresses away from 'paid' (a mis-entered
-- payment deleted or corrected). But the branch was appended AFTER the
-- forward branches of an IF / ELSIF chain, and the FIRST branch is
--   NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent'
-- Deleting the only payment on a paid invoice takes it paid -> 'sent'
-- (trg_invoice_payments_recalc), which satisfies that first branch, so the
-- chain stops there: the branch only updates milestones in ('pending',
-- 'overdue'), the milestone is 'paid', nothing changes — and the regression
-- branch below is never reached. The milestone stayed 'paid' with no
-- payment behind it, looked collected, and could not be billed again.
-- paid -> partially_paid and paid -> overdue were already fine (they fall
-- through to the regression branch); only paid -> sent was broken.
--
-- Fix: test the regression FIRST. Forward branches and their WHERE guards
-- are unchanged.
--
-- Also repairs milestones already stuck: 'paid' milestones whose linked
-- invoices include a live unpaid one and no paid one. A milestone only ever
-- becomes 'paid' through this trigger (there is no manual mark-paid path),
-- so a 'paid' milestone with no paid invoice behind it is by definition
-- stale.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sync_milestone_from_invoice()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.milestone_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Regression first: the invoice left 'paid' (deleted / corrected payment). Only touches a milestone that
  -- is currently 'paid', so it can't clobber a milestone in some other state for an unrelated reason.
  IF OLD IS NOT NULL AND OLD.status = 'paid' AND NEW.status IS DISTINCT FROM 'paid' THEN
    UPDATE public.payment_milestones
      SET status = 'invoiced', paid_at = NULL
      WHERE id = NEW.milestone_id AND status = 'paid';
  ELSIF NEW.status = 'sent' AND (OLD IS NULL OR OLD.status IS DISTINCT FROM 'sent') THEN
    UPDATE public.payment_milestones
      SET status = 'invoiced', invoiced_at = now()
      WHERE id = NEW.milestone_id AND status IN ('pending','overdue');
  ELSIF NEW.status = 'paid' AND (OLD IS NULL OR OLD.status IS DISTINCT FROM 'paid') THEN
    UPDATE public.payment_milestones
      SET status = 'paid', paid_at = now()
      WHERE id = NEW.milestone_id;
  END IF;

  RETURN NEW;
END;
$$;

-- One-off repair of milestones the old ordering left stuck on 'paid'.
UPDATE public.payment_milestones m
   SET status = 'invoiced', paid_at = NULL
 WHERE m.status = 'paid'
   AND EXISTS (
     SELECT 1 FROM public.invoices i
      WHERE i.milestone_id = m.id AND i.status IN ('sent','partially_paid','overdue'))
   AND NOT EXISTS (
     SELECT 1 FROM public.invoices i
      WHERE i.milestone_id = m.id AND i.status = 'paid');
