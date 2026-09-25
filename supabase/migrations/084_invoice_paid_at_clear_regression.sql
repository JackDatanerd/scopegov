-- 084_invoice_paid_at_clear_regression.sql
--
-- BUG (section-12 audit, independent pass 4): recalc_invoice_paid_status()
-- was fixed once already, in 069_approvals_invoicing_hardening.sql, to
-- CLEAR paid_at back to NULL whenever a status recalculation lands
-- anywhere other than 'paid' (or leaves a draft/void invoice alone) —
-- specifically so correcting a mis-entered payment (PATCH/DELETE
-- /api/invoices/[id]/payments/[paymentId]) that un-pays a 'paid' invoice
-- doesn't leave a stale paid_at timestamp sitting on an invoice that is
-- no longer paid.
--
-- 079_approvals_invoicing_independent_pass_3.sql then re-issued a
-- CREATE OR REPLACE of the same function (to fix an unrelated
-- overdue-vs-partially_paid ordering bug) using the ORIGINAL 004 body as
-- its base instead of 069's already-fixed one:
--
--     paid_at = CASE WHEN v_status = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END
--
-- That silently reverted 069's fix — paid_at is a plain PL/pgSQL local
-- reference to the *pre-update* column value here (not OLD), so this
-- always falls through to "leave paid_at exactly as it was" once the
-- invoice has ever been paid once, no matter what v_status is now. A
-- payment correction that reverts a 'paid' invoice to 'partially_paid' or
-- 'sent' keeps its old paid_at forever. That stale timestamp is not
-- cosmetic: it's the exact value api/invoices/export/route.ts prints
-- verbatim as the CSV's "Paid on" column, so an accountant reconciling the
-- ledger sees a paid-on date sitting next to a non-paid status for any
-- invoice whose payment was ever corrected after reaching 'paid'.
--
-- FIX: reinstate 069's clearing behavior (paid_at is NULL whenever
-- v_status is neither 'paid' nor left alone for draft/void) on top of
-- 079's overdue-priority ordering — CREATE OR REPLACE only ever replaces
-- the whole function body, so both fixes have to be restated together to
-- both survive.

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
    -- FIX (independent pass 3): due-date check ahead of the partial-payment
    -- check — an invoice still short of paid AND past due stays/becomes
    -- 'overdue' whether or not a partial payment has landed; the overdue
    -- cron is the only thing that stops touching it once amount_paid
    -- reaches amount ('paid', handled above).
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
    -- FIX (this migration, restoring 069): stamp paid_at the first time
    -- status becomes 'paid'; leave it untouched for draft/void (this
    -- trigger never changes their status, so there's nothing to
    -- reconsider); CLEAR it for every other status — a payment
    -- correction that un-pays an invoice must not leave a stale
    -- paid-on date behind for the export/PDF to keep showing.
    paid_at     = CASE
                    WHEN v_status = 'paid'            THEN COALESCE(paid_at, now())
                    WHEN v_status IN ('draft','void') THEN paid_at
                    ELSE NULL
                  END,
    updated_at  = now()
  WHERE id = v_invoice_id;

  RETURN NULL;
END;
$$;

-- ── DATA FIX: invoices this regression already left with a stale paid_at ──
-- Any invoice currently sitting at a non-paid, non-draft, non-void status
-- with a paid_at already on file is exactly the state this regression
-- produces (or, rarer, a status set directly by another codepath after
-- paid_at was stamped) — clear it now so the export/PDF stop showing a
-- paid-on date for an invoice that is not, in fact, paid.
UPDATE public.invoices
SET paid_at = NULL, updated_at = now()
WHERE status NOT IN ('paid', 'draft', 'void')
  AND paid_at IS NOT NULL;

COMMENT ON FUNCTION public.recalc_invoice_paid_status() IS
  'Recomputes invoices.amount_paid/status/paid_at after any invoice_payments write. overdue takes priority over partially_paid when the due date has passed (independent pass 3). paid_at is cleared whenever status is not paid/draft/void (this migration) — 079 had silently reintroduced 069''s already-fixed stale-paid_at bug by re-issuing CREATE OR REPLACE from the pre-069 body.';
