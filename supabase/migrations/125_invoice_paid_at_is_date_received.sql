-- ============================================================
-- ScopeGov — Migration 125: invoices.paid_at = the date the money was RECEIVED
--
-- BUG (section-12 independent pass 12): recalc_invoice_paid_status() stamped invoices.paid_at with now() —
-- the moment the payment was RECORDED — no matter what "Date received" the agency entered. A payment
-- logged a week late with a back-dated date still gave the invoice that week-late paid_at, and editing a
-- payment's date later never moved it (COALESCE(paid_at, ...) kept the first value). invoices.paid_at is the
-- CSV export's "Paid on" column (api/invoices/export), which is what an accountant reconciles against the
-- bank statement; payment_milestones.paid_at inherited the same wrong value via sync_milestone_from_invoice().
--
-- Now: while an invoice is 'paid', paid_at is derived from its payments — the date of the latest one
-- (stored at midnight UTC; every reader only ever prints the date part) — and is re-derived on every payment
-- insert/update/delete, so correcting a payment's date corrects it. The milestone's paid_at follows.
-- Everything else in the function is unchanged from 084 (overdue-before-partial ordering, paid_at cleared
-- whenever the invoice is not paid/draft/void).
--
-- RUN THIS BEFORE (or together with) deploying; no code change depends on it.
-- ============================================================

CREATE OR REPLACE FUNCTION public.recalc_invoice_paid_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invoice_id   uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_total_paid   decimal;
  v_last_paid_on date;
  v_amount       decimal;
  v_status       text;
  v_due_date     date;
  v_milestone_id uuid;
  v_paid_at      timestamptz;
BEGIN
  SELECT COALESCE(SUM(amount), 0), MAX(paid_at) INTO v_total_paid, v_last_paid_on
  FROM public.invoice_payments WHERE invoice_id = v_invoice_id;

  SELECT amount, status, due_date, milestone_id INTO v_amount, v_status, v_due_date, v_milestone_id
  FROM public.invoices WHERE id = v_invoice_id;

  -- Never touch draft/void invoices' status from this trigger — a draft
  -- shouldn't flip to partially_paid just because someone logged a
  -- payment against it before it was ever sent, and void is terminal.
  IF v_status NOT IN ('draft','void') THEN
    IF v_total_paid >= v_amount THEN
      v_status := 'paid';
    ELSIF v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN
      v_status := 'overdue';
    ELSIF v_total_paid > 0 THEN
      v_status := 'partially_paid';
    ELSE
      v_status := 'sent';
    END IF;
  END IF;

  IF v_status = 'paid' THEN
    v_paid_at := COALESCE((v_last_paid_on::timestamp AT TIME ZONE 'UTC'), now());
  END IF;

  UPDATE public.invoices SET
    amount_paid = v_total_paid,
    status      = v_status,
    paid_at     = CASE
                    WHEN v_status = 'paid'            THEN v_paid_at
                    WHEN v_status IN ('draft','void') THEN paid_at
                    ELSE NULL
                  END,
    updated_at  = now()
  WHERE id = v_invoice_id;

  -- A payment whose date was corrected while the invoice stays 'paid' doesn't change status, so the
  -- status-triggered milestone sync never fires — keep the milestone's paid date in step here.
  IF v_status = 'paid' AND v_milestone_id IS NOT NULL THEN
    UPDATE public.payment_milestones SET paid_at = v_paid_at
    WHERE id = v_milestone_id AND status = 'paid';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.recalc_invoice_paid_status() IS
  'Recomputes invoices.amount_paid/status/paid_at after any invoice_payments write. overdue takes priority over partially_paid when past due (079); paid_at is cleared whenever status is not paid/draft/void (084); while paid, paid_at is the date of the latest payment received, not the moment it was recorded (125).';

-- The status-change milestone sync stamped now(); use the invoice's own (date-received) paid_at instead.
-- Body otherwise identical to 114 (regression branch first).
CREATE OR REPLACE FUNCTION public.sync_milestone_from_invoice()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.milestone_id IS NULL THEN
    RETURN NEW;
  END IF;

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
      SET status = 'paid', paid_at = COALESCE(NEW.paid_at, now())
      WHERE id = NEW.milestone_id;
  END IF;

  RETURN NEW;
END;
$$;

-- ── Backfill ─────────────────────────────────────────────────
-- Paid invoices that have payments on file: paid_at := date of the latest payment.
UPDATE public.invoices i
SET paid_at = (p.last_paid_on::timestamp AT TIME ZONE 'UTC')
FROM (
  SELECT invoice_id, MAX(paid_at) AS last_paid_on
  FROM public.invoice_payments GROUP BY invoice_id
) p
WHERE p.invoice_id = i.id
  AND i.status = 'paid'
  AND i.paid_at IS DISTINCT FROM (p.last_paid_on::timestamp AT TIME ZONE 'UTC');

-- Milestones whose paid invoice now carries the corrected date.
UPDATE public.payment_milestones m
SET paid_at = i.paid_at
FROM public.invoices i
WHERE i.milestone_id = m.id
  AND i.status = 'paid'
  AND i.paid_at IS NOT NULL
  AND m.status = 'paid'
  AND m.paid_at IS DISTINCT FROM i.paid_at;
