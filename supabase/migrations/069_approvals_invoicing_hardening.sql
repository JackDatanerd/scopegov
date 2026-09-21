-- ============================================================
-- ScopeGov — Migration 069: Approvals engine + Invoicing hardening
-- (deep audit, sections 11 and 12)
--
-- RUN THIS BEFORE DEPLOYING THE MATCHING CODE. The approval decision
-- path now calls decide_approval_step()/finalize_approval_send(), and the
-- invoice send path calls finalize_invoice_send(); both are created here.
--
-- Contents
--   A. Approval policy flags (self-approval, distinct approvers,
--      other-currency gating) on workflows, snapshotted onto requests
--   B. Request bookkeeping: reminder/escalation counters, "sending"
--      marker (keeps the edit-lock up while an auto-send is running),
--      delivery warning (sent, but the client email bounced)
--   C. approval_steps.approver_role_id FK: ON DELETE SET NULL so a role
--      that ever appeared in a (finished) request can still be deleted
--   D. One ACTIVE request per document — pending OR approved-not-sent —
--      enforced by a partial unique index (after de-duplicating)
--   E. decide_approval_step() / finalize_approval_send(): the decision
--      is now ONE transaction with the request row locked, instead of
--      five sequential writes with no error handling
--   F. Invoices: round money to 2dp on write (BEFORE trigger) + backfill,
--      paid-status trigger tolerance + paid_at clearing, one live invoice
--      per milestone, atomic "number + send" finalize_invoice_send()
-- ============================================================

-- ── A. policy flags ─────────────────────────────────────────
ALTER TABLE public.approval_workflows
  ADD COLUMN IF NOT EXISTS allow_self_approval        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_distinct_approvers boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS apply_to_other_currencies  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.approval_workflows.allow_self_approval IS
  'When true the person who requested a send may also decide the steps they are eligible for (sole-approver / solo-agency workspaces). Default false.';
COMMENT ON COLUMN public.approval_workflows.require_distinct_approvers IS
  'When true one person may approve at most one step of a request (four-eyes across a multi-step chain).';
COMMENT ON COLUMN public.approval_workflows.apply_to_other_currencies IS
  'A thresholded workflow only compares amounts in its own threshold_currency. When true it ALSO gates documents in any other currency (no conversion — every such document is gated) instead of letting them through ungated.';

-- The atomic workflow-edit function from migration 067 only knew four fields.
-- Same signature, extended with the three policy flags (a JSON key that is
-- absent leaves the column unchanged).
CREATE OR REPLACE FUNCTION public.update_approval_workflow_atomic(
  p_workspace_id uuid,
  p_workflow_id  uuid,
  p_patch        jsonb,
  p_set_steps    boolean,
  p_steps        jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_step  jsonb;
  v_order integer := 0;
BEGIN
  PERFORM 1 FROM public.approval_workflows
   WHERE id = p_workflow_id AND workspace_id = p_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_not_found';
  END IF;

  IF p_set_steps THEN
    IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) = 0 THEN
      RAISE EXCEPTION 'steps_required';
    END IF;
  END IF;

  UPDATE public.approval_workflows SET
    name                       = CASE WHEN p_patch ? 'name'                       THEN p_patch->>'name'                                ELSE name END,
    threshold_amount           = CASE WHEN p_patch ? 'threshold_amount'           THEN (p_patch->>'threshold_amount')::numeric         ELSE threshold_amount END,
    threshold_currency         = CASE WHEN p_patch ? 'threshold_currency'         THEN p_patch->>'threshold_currency'                  ELSE threshold_currency END,
    is_active                  = CASE WHEN p_patch ? 'is_active'                  THEN (p_patch->>'is_active')::boolean                ELSE is_active END,
    allow_self_approval        = CASE WHEN p_patch ? 'allow_self_approval'        THEN (p_patch->>'allow_self_approval')::boolean        ELSE allow_self_approval END,
    require_distinct_approvers = CASE WHEN p_patch ? 'require_distinct_approvers' THEN (p_patch->>'require_distinct_approvers')::boolean ELSE require_distinct_approvers END,
    apply_to_other_currencies  = CASE WHEN p_patch ? 'apply_to_other_currencies'  THEN (p_patch->>'apply_to_other_currencies')::boolean  ELSE apply_to_other_currencies END,
    updated_at                 = now()
  WHERE id = p_workflow_id;

  IF p_set_steps THEN
    DELETE FROM public.approval_workflow_steps WHERE workflow_id = p_workflow_id;
    FOR v_step IN SELECT * FROM jsonb_array_elements(p_steps) LOOP
      v_order := v_order + 1;
      INSERT INTO public.approval_workflow_steps (workflow_id, step_order, approver_role_id, approver_user_id)
      VALUES (
        p_workflow_id, v_order,
        NULLIF(v_step->>'approverRoleId', '')::uuid,
        NULLIF(v_step->>'approverUserId', '')::uuid
      );
    END LOOP;
  END IF;
END;
$$;

-- ── B. request bookkeeping ──────────────────────────────────
ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS allow_self_approval        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_distinct_approvers boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_count             int     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escalated_at               timestamptz,
  ADD COLUMN IF NOT EXISTS sending_started_at         timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_warning           text;

COMMENT ON COLUMN public.approval_requests.sending_started_at IS
  'Set by decide_approval_step() when the last step clears; the request stays status=pending (so the document edit-lock holds) until finalize_approval_send() records whether the auto-send worked. The approval-stall cron heals a request stuck here.';
COMMENT ON COLUMN public.approval_requests.delivery_warning IS
  'The document WAS sent (status stays approved) but the email to the client was rejected by the mail provider — the requester is told to copy the link.';

-- ── C. role FK ──────────────────────────────────────────────
ALTER TABLE public.approval_steps DROP CONSTRAINT IF EXISTS approval_steps_approver_role_id_fkey;
ALTER TABLE public.approval_steps
  ADD CONSTRAINT approval_steps_approver_role_id_fkey
  FOREIGN KEY (approver_role_id) REFERENCES public.roles(id) ON DELETE SET NULL;

-- ── D. one active request per document ──────────────────────
-- A stale approved-but-not-sent request left behind by a second chain is
-- closed out first (keep the newest active one per document).
UPDATE public.approval_requests r
SET status = 'cancelled', decided_at = now(), updated_at = now()
WHERE r.status = 'approved' AND r.send_failed_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.approval_requests o
    WHERE o.document_type = r.document_type AND o.document_id = r.document_id AND o.id <> r.id
      AND (o.status = 'pending' OR (o.status = 'approved' AND o.send_failed_at IS NOT NULL AND o.created_at > r.created_at))
  );

CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_one_active_per_doc
  ON public.approval_requests(document_type, document_id)
  WHERE status = 'pending' OR (status = 'approved' AND send_failed_at IS NOT NULL);

-- ── E. atomic decision ──────────────────────────────────────
-- Returns: 'conflict' | 'rejected' | 'advanced' | 'final'
--   'final' = the last step just approved. The request is left status
--   'pending' with sending_started_at set; the caller performs the send and
--   then calls finalize_approval_send().
CREATE OR REPLACE FUNCTION public.decide_approval_step(
  p_request_id uuid,
  p_step_id    uuid,
  p_decision   text,
  p_actor_id   uuid,
  p_note       text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status      text;
  v_current     int;
  v_total       int;
  v_step_status text;
  v_step_order  int;
  v_now         timestamptz := now();
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;

  SELECT status, current_step, total_steps INTO v_status, v_current, v_total
  FROM public.approval_requests WHERE id = p_request_id FOR UPDATE;

  IF v_status IS NULL OR v_status <> 'pending' THEN
    RETURN 'conflict';
  END IF;

  SELECT status, step_order INTO v_step_status, v_step_order
  FROM public.approval_steps WHERE id = p_step_id AND request_id = p_request_id FOR UPDATE;

  IF v_step_status IS NULL OR v_step_status <> 'pending' OR v_step_order <> v_current THEN
    RETURN 'conflict';
  END IF;

  UPDATE public.approval_steps
  SET status = p_decision, decided_by = p_actor_id, decided_at = v_now, note = p_note
  WHERE id = p_step_id;

  IF p_decision = 'rejected' THEN
    UPDATE public.approval_steps SET status = 'skipped'
    WHERE request_id = p_request_id AND status = 'pending';
    UPDATE public.approval_requests
    SET status = 'rejected', decided_at = v_now, updated_at = v_now
    WHERE id = p_request_id;
    RETURN 'rejected';
  END IF;

  IF v_current < v_total THEN
    UPDATE public.approval_requests
    SET current_step = v_current + 1, updated_at = v_now, reminder_count = 0, escalated_at = NULL
    WHERE id = p_request_id;
    RETURN 'advanced';
  END IF;

  UPDATE public.approval_requests
  SET sending_started_at = v_now, updated_at = v_now
  WHERE id = p_request_id;
  RETURN 'final';
END;
$$;

REVOKE ALL ON FUNCTION public.decide_approval_step(uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_approval_step(uuid, uuid, text, uuid, text) TO service_role;

-- Records the outcome of the auto-send that follows a final approval.
-- Returns false when the request is no longer a pending, sending request
-- (e.g. it was cancelled while the send was in flight).
CREATE OR REPLACE FUNCTION public.finalize_approval_send(
  p_request_id       uuid,
  p_send_ok          boolean,
  p_error            text,
  p_delivery_warning text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.approval_requests
  SET status             = 'approved',
      decided_at         = now(),
      updated_at         = now(),
      sending_started_at = NULL,
      send_failed_at     = CASE WHEN p_send_ok THEN NULL ELSE now() END,
      send_failed_reason = CASE WHEN p_send_ok THEN NULL ELSE p_error END,
      delivery_warning   = CASE WHEN p_send_ok THEN p_delivery_warning ELSE NULL END
  WHERE id = p_request_id AND status = 'pending' AND sending_started_at IS NOT NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_approval_send(uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_approval_send(uuid, boolean, text, text) TO service_role;

-- ── F. invoices ─────────────────────────────────────────────
-- F1. Money is stored to 2dp. Tax-exclusive amounts used to be
--     net × (1 + rate) with no rounding into an unconstrained numeric, so a
--     client paying the amount printed on the PDF could leave a fraction of
--     a cent outstanding and the invoice stuck 'partially_paid' forever.
CREATE OR REPLACE FUNCTION public.round_invoice_money()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount   IS NOT NULL THEN NEW.amount   := round(NEW.amount, 2);   END IF;
  IF NEW.subtotal IS NOT NULL THEN NEW.subtotal := round(NEW.subtotal, 2); END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoices_round_money ON public.invoices;
CREATE TRIGGER trg_invoices_round_money
  BEFORE INSERT OR UPDATE OF amount, subtotal ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.round_invoice_money();

-- F2. Paid-status recalculation: tolerate sub-cent residue, and clear
--     paid_at when an invoice regresses away from 'paid' (a deleted payment).
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
    IF v_total_paid >= v_amount - 0.005 THEN
      v_status := 'paid';
    ELSIF v_total_paid > 0 THEN
      v_status := 'partially_paid';
    ELSIF v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN
      v_status := 'overdue';
    ELSE
      v_status := 'sent';
    END IF;
  END IF;

  UPDATE public.invoices SET
    amount_paid = v_total_paid,
    status      = v_status,
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

-- F3. Backfill: round existing money, settle invoices that were stuck on a
--     sub-cent residue, and clear stale paid_at on invoices no longer paid.
UPDATE public.invoices
SET amount   = round(amount, 2),
    subtotal = CASE WHEN subtotal IS NULL THEN NULL ELSE round(subtotal, 2) END
WHERE status <> 'void'
  AND (amount <> round(amount, 2) OR (subtotal IS NOT NULL AND subtotal <> round(subtotal, 2)));

UPDATE public.invoices
SET status = 'paid', paid_at = COALESCE(paid_at, now()), updated_at = now()
WHERE status = 'partially_paid' AND amount_paid > 0 AND amount_paid >= amount - 0.005;

UPDATE public.invoices
SET paid_at = NULL
WHERE paid_at IS NOT NULL AND status IN ('draft', 'sent', 'partially_paid', 'overdue');

-- F4. At most one live (non-void) invoice per milestone. Created only when
--     no duplicates exist today; otherwise a WARNING lists what to void
--     first (the API also enforces this at create and at send).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.invoices
    WHERE milestone_id IS NOT NULL AND status <> 'void'
    GROUP BY milestone_id HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'invoices_one_active_per_milestone was NOT created: some milestones already have more than one non-void invoice. Void the duplicates, then re-run: CREATE UNIQUE INDEX invoices_one_active_per_milestone ON public.invoices(milestone_id) WHERE milestone_id IS NOT NULL AND status <> ''void'';';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_active_per_milestone
      ON public.invoices(milestone_id) WHERE milestone_id IS NOT NULL AND status <> 'void';
  END IF;
END;
$$;

-- F5. Send = assign the invoice number + flip draft->sent in ONE transaction.
--     Previously the number was claimed first and the status guard ran
--     after, so a lost race or a failed update burned an invoice number
--     (gaps in a sequence that many tax regimes require to be unbroken).
--     Returns the invoice number, or NULL when the invoice is not a draft.
CREATE OR REPLACE FUNCTION public.finalize_invoice_send(
  p_invoice_id   uuid,
  p_workspace_id uuid,
  p_token        text,
  p_expires_at   timestamptz,
  p_now          timestamptz
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
  v_number text;
BEGIN
  SELECT status, invoice_number INTO v_status, v_number
  FROM public.invoices
  WHERE id = p_invoice_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF v_status IS NULL OR v_status <> 'draft' THEN
    RETURN NULL;
  END IF;

  IF v_number IS NULL THEN
    v_number := public.assign_document_number(p_workspace_id, 'invoice');
  END IF;

  UPDATE public.invoices
  SET status = 'sent', sent_at = p_now, token = p_token, expires_at = p_expires_at,
      invoice_number = v_number, updated_at = p_now
  WHERE id = p_invoice_id;

  RETURN v_number;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_invoice_send(uuid, uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_invoice_send(uuid, uuid, text, timestamptz, timestamptz) TO service_role;
