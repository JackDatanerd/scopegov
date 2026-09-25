-- ============================================================
-- ScopeGov — Approval workflows engine (section 11) + Invoicing (section 12)
-- Independent re-audit, fix round 3
--
-- One bug fixed here, in the DB: an overdue invoice that receives a partial
-- payment loses its 'overdue' status even though it's still overdue.
-- ============================================================

-- ── recalc_invoice_paid_status: 'overdue' must survive a partial payment ──
--
-- BUG: recalc_invoice_paid_status() (004_invoicing.sql) checked
-- `v_total_paid > 0` (→ 'partially_paid') BEFORE checking whether the due
-- date had passed (→ 'overdue'). So an invoice sitting at status='overdue'
-- that receives ANY partial payment — even $1 against a $10,000 balance —
-- flips straight back to 'partially_paid', with no due-date check at all.
-- Nothing else ever re-applies 'overdue': the payment-overdue cron
-- (app/api/cron/payment-overdue) only scans status IN ('sent',
-- 'partially_paid') and will pick it right back up on its next run and
-- flip it BACK to 'overdue' — re-firing the "invoice overdue" audit row,
-- in-app notification and email to every VIEW_FINANCIALS holder for money
-- that's already, partly, in hand. That loop repeats every cron run for as
-- long as the invoice stays short of paid in full and past due — the exact
-- scenario a partial payment on a stale invoice creates.
--
-- FIX: check the due date FIRST. An invoice that still owes money and is
-- past its due date is 'overdue' regardless of whether a partial payment
-- has landed against it — amount_paid still updates either way, so the UI
-- and PDF still show the partial payment correctly; only the status label
-- (and therefore what the overdue cron will and won't touch) changes.
-- 'partially_paid' now means specifically "owes money, not yet due (or no
-- due date set)".
CREATE OR REPLACE FUNCTION public.recalc_invoice_paid_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invoice_id uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_total_paid decimal;
  v_amount     decimal;
  v_status     text;
  v_due_date   date;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.invoice_payments WHERE invoice_id = v_invoice_id;

  SELECT amount, status, due_date INTO v_amount, v_status, v_due_date
  FROM public.invoices WHERE id = v_invoice_id;

  -- Never touch draft/void invoices' status from this trigger — a draft
  -- shouldn't flip to partially_paid just because someone logged a
  -- payment against it before it was ever sent, and void is terminal.
  IF v_status NOT IN ('draft','void') THEN
    IF v_total_paid >= v_amount THEN
      v_status := 'paid';
    -- FIX (independent pass 3): due-date check moved ahead of the partial-
    -- payment check — see header note. An invoice still short of paid AND
    -- past due stays/becomes 'overdue' whether or not a partial payment
    -- has landed; the overdue cron is the only thing that stops touching
    -- it once amount_paid reaches amount ('paid', handled above).
    ELSIF v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN
      v_status := 'overdue';
    ELSIF v_total_paid > 0 THEN
      v_status := 'partially_paid';
    ELSE
      v_status := 'sent';
    END IF;
  END IF;

  UPDATE public.invoices SET
    amount_paid = v_total_paid,
    status      = v_status,
    paid_at     = CASE WHEN v_status = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END,
    updated_at  = now()
  WHERE id = v_invoice_id;

  RETURN NULL;
END;
$$;

-- ── DATA FIX: invoices this bug already put in the wrong bucket ──
-- Any non-void, non-draft invoice that's short of paid in full and past
-- its due date should read 'overdue' right now, whether or not it happens
-- to currently say 'partially_paid'. Re-running the same priority the
-- function above now uses, as a one-time correction; touches nothing that
-- isn't actually past due and short-paid.
UPDATE public.invoices
SET status = 'overdue', updated_at = now()
WHERE status = 'partially_paid'
  AND due_date IS NOT NULL AND due_date < CURRENT_DATE
  AND amount_paid < amount;

COMMENT ON FUNCTION public.recalc_invoice_paid_status() IS
  'Recomputes invoices.amount_paid/status/paid_at after any invoice_payments write. overdue takes priority over partially_paid when the due date has passed (independent pass 3) — a partial payment must not silently clear the overdue flag and re-trigger the overdue cron''s next-run notification for a balance that''s still outstanding and still late.';
