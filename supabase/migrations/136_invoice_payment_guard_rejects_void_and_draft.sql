-- ============================================================
-- ScopeGov — Migration 136: invoice_payments guard also refuses a DRAFT or VOID invoice
--
-- BUG (section-12 independent pass): POST /api/invoices/[id]/payments (and PATCH .../payments/[paymentId])
-- check the invoice's status in application code, then write in a separate statement. The overpayment guard
-- (migration 016) locks the parent invoice row but only ever looked at its AMOUNT, never its STATUS. A void
-- that commits between the route's read and its insert therefore let a payment land on a voided invoice:
-- recalc_invoice_paid_status() then set amount_paid > 0 on it, the void route's "money was already received —
-- give a reason and confirm" safeguard (and its amount_paid_at_void audit field) never ran, and finance was
-- notified of a payment on an invoice the client had just been told was void. (A payment landing FIRST is
-- already safe: the void's compare-and-swap on amount_paid fails.)
--
-- Fix: the guard reads the status under the SAME row lock it already takes. Because the lock waits for a
-- concurrent void to commit and then re-reads the row, the check sees the committed status. A payment may
-- not be INSERTed against a draft/void invoice, and an existing payment on one may not have its amount, date
-- or invoice changed. DELETE is untouched (workspace purge cascades through it; the route blocks it on void).
-- Everything else in the function is unchanged from 016.
--
-- RUN THIS BEFORE (or together with) deploying; the routes handle the new error either way.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_invoice_payment_overpayment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invoice_id     uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_invoice_amount decimal;
  v_invoice_status text;
  v_total_after    decimal;
BEGIN
  -- Lock the parent invoice row for the duration of this transaction — a concurrent payment write against the
  -- SAME invoice (or a concurrent void) blocks here until the other transaction commits or rolls back.
  SELECT amount, status INTO v_invoice_amount, v_invoice_status
  FROM public.invoices WHERE id = v_invoice_id FOR UPDATE;

  IF v_invoice_amount IS NULL THEN
    RETURN NEW; -- invoice row not found — let the FK constraint handle it
  END IF;

  IF v_invoice_status IN ('draft', 'void') THEN
    -- Nested, not one OR chain: OLD must never be read on an INSERT.
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Payments cannot be recorded on a draft or void invoice (invoice status %)', v_invoice_status
        USING ERRCODE = 'check_violation';
    ELSIF TG_OP = 'UPDATE' AND (NEW.amount     IS DISTINCT FROM OLD.amount
                             OR NEW.paid_at    IS DISTINCT FROM OLD.paid_at
                             OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id) THEN
      RAISE EXCEPTION 'Payments cannot be recorded on a draft or void invoice (invoice status %)', v_invoice_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_total_after
  FROM public.invoice_payments
  WHERE invoice_id = v_invoice_id AND id IS DISTINCT FROM OLD.id;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_total_after := v_total_after + NEW.amount;
  END IF;

  -- Small epsilon for float/decimal rounding, matching the app-layer check this backstops.
  IF v_total_after > v_invoice_amount + 0.005 THEN
    RAISE EXCEPTION 'Payment would exceed invoice balance (total % > invoice amount %)',
      v_total_after, v_invoice_amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
