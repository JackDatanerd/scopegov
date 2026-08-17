-- ============================================================
-- ScopeGov — Overpayment guard on invoice_payments
--
-- FIX (re-audit, race-condition finding): app/api/invoices/[id]/payments
-- (POST) reads invoices.amount / amount_paid, computes the remaining
-- balance, and rejects a payment that would exceed it — entirely in
-- application code, with no DB-level backstop. Two concurrent payment
-- submissions against the same invoice (two staff logging the same wire
-- transfer, or a retried request) can each read the balance before
-- either write commits, both pass the app-layer check, and together
-- overpay the invoice — amount_paid then exceeds amount, and the
-- existing trg_invoice_payments_recalc trigger (004_invoicing.sql) just
-- clamps status to 'paid' rather than rejecting, so the overage is
-- silent.
--
-- This closes the race at the only place it can actually be closed:
-- inside the same trigger that already owns this invariant. Locking the
-- parent invoices row (SELECT ... FOR UPDATE) before summing serializes
-- concurrent payment inserts/updates against the same invoice — the
-- second transaction blocks until the first commits, then sees its
-- effect, rather than both computing the same stale total in parallel.
-- Deletes are exempt (removing a payment can only reduce the total).
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_invoice_payment_overpayment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invoice_id    uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_invoice_amount decimal;
  v_total_after   decimal;
BEGIN
  -- Lock the parent invoice row for the duration of this transaction —
  -- a concurrent payment insert/update against the SAME invoice will
  -- block here until this transaction commits or rolls back, so the
  -- SUM below can never race against another in-flight payment on this
  -- invoice.
  SELECT amount INTO v_invoice_amount
  FROM public.invoices WHERE id = v_invoice_id FOR UPDATE;

  IF v_invoice_amount IS NULL THEN
    RETURN NEW; -- invoice row not found — let the FK constraint handle it
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_total_after
  FROM public.invoice_payments
  WHERE invoice_id = v_invoice_id AND id IS DISTINCT FROM OLD.id;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_total_after := v_total_after + NEW.amount;
  END IF;

  -- Small epsilon for float/decimal rounding, matching the app-layer
  -- check this backstops (see app/api/invoices/[id]/payments/route.ts).
  IF v_total_after > v_invoice_amount + 0.005 THEN
    RAISE EXCEPTION 'Payment would exceed invoice balance (total % > invoice amount %)',
      v_total_after, v_invoice_amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- BEFORE, not AFTER: this must reject the write before it lands, unlike
-- trg_invoice_payments_recalc (AFTER, since that one only ever reconciles
-- state that's already valid by the time it runs).
CREATE OR REPLACE TRIGGER trg_invoice_payments_overpayment_guard
  BEFORE INSERT OR UPDATE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_payment_overpayment();
