-- ============================================================
-- 096: close the SOW/CO cumulative invoicing-cap race
--
-- RUN THIS BEFORE DEPLOYING THE MATCHING CODE (app/api/invoices/route.ts,
-- app/api/invoices/[id]/route.ts).
--
-- FIX (section-12 independent audit): a milestone can only ever carry one
-- live invoice — migration 069 backstops that with a real unique index, so
-- even a dead-even race between two creates is physically impossible. The
-- SOW/CO cumulative cap ("every non-void invoice against this SOW/CO may
-- never total more than its own value") has no equivalent: both
-- POST /api/invoices and PATCH /api/invoices/[id] read every prior
-- invoice's subtotal, sum it, compare to the cap, and only THEN insert or
-- update — three separate round trips with nothing holding a lock across
-- them. Two requests against the SAME sow_id/co_id close enough together
-- (two teammates invoicing the last of a SOW at once, or one person
-- double-submitting) can each read the same "already invoiced" total,
-- each pass the check independently, and both write — together billing
-- the client past what the SOW/CO was ever accepted for, with no
-- server-side guard catching it after the fact the way migration 016's
-- overpayment trigger catches an overpaying invoice_payments insert.
--
-- Fix: move the "lock the source, recompute the cumulative sum, compare
-- to the cap, then write" sequence into one atomic function per route, so
-- a second concurrent caller's cumulative read can't even start until the
-- first has committed (or rolled back). The cap itself is still computed
-- in TypeScript (lib/reports/contract-position.ts's baseContractValue,
-- including the open-ended-retainer/billed-months handling) — these
-- functions only take the already-computed cap as a numeric input and are
-- responsible purely for making the check-then-write atomic, not for
-- reimplementing retainer business logic in SQL.
--
-- p_source_column/p_cap are NULL for a milestone-sourced invoice (or, in
-- the update function, an edit that touches no money field): no
-- cumulative sum applies there, so the functions skip straight to the
-- plain insert/update. The milestone case still gets its existing
-- concurrency protection from migration 069's unique index, surfaced here
-- as a caught unique_violation on create.

CREATE OR REPLACE FUNCTION public.create_invoice_capped(
  p_workspace_id         uuid,
  p_project_id           uuid,
  p_source_column        text,     -- 'sow_id' | 'co_id' | NULL (milestone — no cumulative cap here)
  p_source_id            uuid,
  p_cap                  numeric,  -- NULL = uncapped (open-ended retainer) or not applicable
  p_milestone_id         uuid,
  p_sow_id               uuid,
  p_co_id                uuid,
  p_title                text,
  p_amount               numeric,
  p_subtotal             numeric,
  p_tax_rate             numeric,
  p_tax_inclusive        boolean,
  p_line_items           jsonb,
  p_currency             text,
  p_due_date             date,
  p_po_number            text,
  p_payment_instructions text,
  p_notes                text,
  p_created_by           uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_already numeric;
  v_id      uuid;
BEGIN
  IF p_source_column IS NOT NULL AND p_source_column NOT IN ('sow_id', 'co_id') THEN
    RAISE EXCEPTION 'invalid_source_column';
  END IF;

  -- Lock the source document row first: a second concurrent call against
  -- the SAME sow/co blocks here until this transaction commits or rolls
  -- back, so its own cumulative-sum read below can never overlap this one.
  IF p_source_column = 'sow_id' THEN
    PERFORM 1 FROM public.sow_documents WHERE id = p_source_id FOR UPDATE;
  ELSIF p_source_column = 'co_id' THEN
    PERFORM 1 FROM public.change_orders WHERE id = p_source_id FOR UPDATE;
  END IF;

  IF p_cap IS NOT NULL THEN
    EXECUTE format(
      'SELECT COALESCE(SUM(COALESCE(subtotal, amount)), 0) FROM public.invoices WHERE %I = $1 AND status <> ''void''',
      p_source_column
    ) INTO v_already USING p_source_id;

    IF v_already + p_subtotal > p_cap + 0.01 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'over_cap', 'already_invoiced', v_already);
    END IF;
  END IF;

  INSERT INTO public.invoices (
    workspace_id, project_id, milestone_id, sow_id, co_id, title,
    amount, subtotal, tax_rate, tax_inclusive, line_items,
    currency, due_date, po_number, payment_instructions, notes, created_by
  ) VALUES (
    p_workspace_id, p_project_id, p_milestone_id, p_sow_id, p_co_id, p_title,
    p_amount, p_subtotal, p_tax_rate, p_tax_inclusive, p_line_items,
    p_currency, p_due_date, p_po_number, p_payment_instructions, p_notes, p_created_by
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
-- The one-live-invoice-per-milestone unique index (migration 069) is the
-- milestone side's own concurrency backstop; surface a collision the same
-- clean way the route already handles it instead of an opaque 500.
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'code', 'duplicate_milestone');
END;
$$;

COMMENT ON FUNCTION public.create_invoice_capped IS
  'Atomic create for POST /api/invoices: locks the sow/co row (when p_source_column is set), re-sums every non-void invoice already against it, and only inserts if the new subtotal still fits p_cap. Closes the read-then-write race the plain three-step app-level check could not.';

CREATE OR REPLACE FUNCTION public.update_invoice_capped(
  p_invoice_id    uuid,
  p_workspace_id  uuid,
  p_source_column text,     -- 'sow_id' | 'co_id' | NULL (milestone, or an edit touching no money field)
  p_source_id     uuid,
  p_cap           numeric,  -- NULL = uncapped or not applicable
  p_new_subtotal  numeric,  -- only consulted when p_cap IS NOT NULL
  p_update        jsonb     -- exactly the `update` object PATCH already builds; only keys present are touched
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_already numeric;
  v_id      uuid;
  v_now     timestamptz := now();
BEGIN
  IF p_source_column IS NOT NULL AND p_source_column NOT IN ('sow_id', 'co_id') THEN
    RAISE EXCEPTION 'invalid_source_column';
  END IF;

  IF p_source_column = 'sow_id' THEN
    PERFORM 1 FROM public.sow_documents WHERE id = p_source_id FOR UPDATE;
  ELSIF p_source_column = 'co_id' THEN
    PERFORM 1 FROM public.change_orders WHERE id = p_source_id FOR UPDATE;
  END IF;

  IF p_cap IS NOT NULL THEN
    EXECUTE format(
      'SELECT COALESCE(SUM(COALESCE(subtotal, amount)), 0) FROM public.invoices WHERE %I = $1 AND status <> ''void'' AND id <> $2',
      p_source_column
    ) INTO v_already USING p_source_id, p_invoice_id;

    IF v_already + p_new_subtotal > p_cap + 0.01 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'over_cap', 'already_invoiced', v_already);
    END IF;
  END IF;

  -- Same single combined write PATCH always did (money + everything else
  -- together, CAS'd on status='draft') — just relocated inside the lock so
  -- the cap check above and this write can't be split by a concurrent
  -- editor. A key ABSENT from p_update leaves that column untouched; a key
  -- present with a JSON null clears it (due_date/po_number/
  -- payment_instructions/notes are all legitimately nullable).
  UPDATE public.invoices SET
    title                = CASE WHEN p_update ? 'title'                THEN p_update->>'title'                     ELSE title END,
    due_date             = CASE WHEN p_update ? 'due_date'             THEN NULLIF(p_update->>'due_date', '')::date ELSE due_date END,
    po_number            = CASE WHEN p_update ? 'po_number'            THEN p_update->>'po_number'                  ELSE po_number END,
    payment_instructions = CASE WHEN p_update ? 'payment_instructions' THEN p_update->>'payment_instructions'       ELSE payment_instructions END,
    notes                = CASE WHEN p_update ? 'notes'                THEN p_update->>'notes'                     ELSE notes END,
    amount               = CASE WHEN p_update ? 'amount'               THEN (p_update->>'amount')::numeric          ELSE amount END,
    subtotal             = CASE WHEN p_update ? 'subtotal'             THEN (p_update->>'subtotal')::numeric        ELSE subtotal END,
    tax_rate             = CASE WHEN p_update ? 'tax_rate'             THEN (p_update->>'tax_rate')::numeric        ELSE tax_rate END,
    tax_inclusive        = CASE WHEN p_update ? 'tax_inclusive'        THEN (p_update->>'tax_inclusive')::boolean   ELSE tax_inclusive END,
    line_items           = CASE WHEN p_update ? 'line_items'           THEN (p_update->'line_items')                ELSE line_items END,
    updated_at           = v_now
  WHERE id = p_invoice_id AND workspace_id = p_workspace_id AND status = 'draft'
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_draft');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

COMMENT ON FUNCTION public.update_invoice_capped IS
  'Atomic edit for PATCH /api/invoices/[id]: locks the sow/co row (when p_source_column is set), re-sums every OTHER non-void invoice against it, and only writes if the new subtotal still fits p_cap. Same still-draft CAS the plain update always had, just inside the same lock as the cap check.';
