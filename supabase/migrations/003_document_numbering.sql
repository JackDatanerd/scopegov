-- ============================================================
-- ScopeGov — Phase 0: Document Numbering (SOW / CO / INV)
-- Gives every SOW, CO, and (Phase 4a) invoice a stable,
-- sequential, per-workspace document number, assigned at send
-- time (not on draft creation, so abandoned drafts don't burn
-- a number). Run after 001_initial_schema.sql + 002_signatures.sql.
-- ============================================================

-- ── SEQUENCE TABLE ───────────────────────────────────────────
-- One row per (workspace, document_type). next_number is the
-- number that will be handed out NEXT — incremented atomically
-- by assign_document_number() below via UPDATE ... RETURNING,
-- never read-then-write, so concurrent sends in the same
-- workspace can't collide on the same number.
CREATE TABLE IF NOT EXISTS public.workspace_document_sequences (
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('sow','co','invoice')),
  next_number   integer NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, document_type)
);

ALTER TABLE public.workspace_document_sequences ENABLE ROW LEVEL SECURITY;
-- No client-facing policy — this table is only ever touched via the
-- service-role client inside assign_document_number()/API routes,
-- same pattern as payment_milestones etc.

-- ── COLUMNS ───────────────────────────────────────────────────
ALTER TABLE public.sow_documents    ADD COLUMN IF NOT EXISTS document_number text;
ALTER TABLE public.change_orders    ADD COLUMN IF NOT EXISTS document_number text;

-- Numbers are per-workspace unique once assigned (drafts stay NULL,
-- so partial index only enforces uniqueness among numbered docs).
CREATE UNIQUE INDEX IF NOT EXISTS sow_documents_document_number
  ON public.sow_documents(workspace_id, document_number) WHERE document_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS change_orders_document_number
  ON public.change_orders(workspace_id, document_number) WHERE document_number IS NOT NULL;

-- ── ATOMIC GENERATOR ──────────────────────────────────────────
-- SECURITY DEFINER so it can be called with the anon/authenticated
-- role too if ever needed, though in practice every caller here is
-- the service-role client from an API route. UPSERT + RETURNING is
-- atomic under Postgres's row-level locking — two concurrent sends
-- for the same workspace/type will serialize on the row lock, not
-- both read next_number=5 and both mint "…-0005".
CREATE OR REPLACE FUNCTION public.assign_document_number(
  p_workspace_id  uuid,
  p_document_type text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_next   integer;
  v_prefix text;
BEGIN
  IF p_document_type NOT IN ('sow','co','invoice') THEN
    RAISE EXCEPTION 'Invalid document_type: %', p_document_type;
  END IF;

  -- Atomic claim-and-increment: if no row exists yet, insert one that has
  -- ALREADY reserved number 1 (next_number starts at 2 for the row after
  -- claiming 1). If a row exists, the ON CONFLICT branch reserves the
  -- current next_number and advances it in the same statement. Either way
  -- RETURNING hands back the number that was JUST claimed, not the one
  -- left behind for the next caller — so two concurrent callers can never
  -- both walk away with the same number.
  INSERT INTO public.workspace_document_sequences AS s (workspace_id, document_type, next_number)
  VALUES (p_workspace_id, p_document_type, 2)
  ON CONFLICT (workspace_id, document_type)
  DO UPDATE SET next_number = s.next_number + 1, updated_at = now()
  RETURNING (CASE WHEN xmax = 0 THEN 1 ELSE s.next_number - 1 END) INTO v_next;

  v_prefix := CASE p_document_type
    WHEN 'sow'     THEN 'SOW'
    WHEN 'co'      THEN 'CO'
    WHEN 'invoice' THEN 'INV'
  END;

  RETURN v_prefix || '-' || lpad(v_next::text, 4, '0');
END;
$$;

-- ── BACKFILL ──────────────────────────────────────────────────
-- Existing signed SOWs and accepted/closed COs in production had no
-- numbering scheme at all. Backfill retroactively, chronological by
-- sent_at (falling back to created_at if sent_at is somehow null),
-- per workspace, so the sequence is continuous from history rather
-- than starting mid-stream. This also seeds workspace_document_sequences
-- so the very next live send continues the count correctly instead of
-- restarting at SOW-0001.
DO $$
DECLARE
  ws        RECORD;
  doc       RECORD;
  v_counter integer;
BEGIN
  -- SOWs: number every document that was ever sent (any status past
  -- draft), so historical declined/expired/withdrawn SOWs keep their
  -- place in sequence rather than leaving numbering gaps that look
  -- like a bug to an auditor.
  FOR ws IN SELECT DISTINCT workspace_id FROM public.sow_documents WHERE sent_at IS NOT NULL LOOP
    v_counter := 1;
    FOR doc IN
      SELECT id FROM public.sow_documents
      WHERE workspace_id = ws.workspace_id AND sent_at IS NOT NULL
      ORDER BY sent_at ASC, created_at ASC
    LOOP
      UPDATE public.sow_documents
        SET document_number = 'SOW-' || lpad(v_counter::text, 4, '0')
        WHERE id = doc.id AND document_number IS NULL;
      v_counter := v_counter + 1;
    END LOOP;

    INSERT INTO public.workspace_document_sequences (workspace_id, document_type, next_number)
    VALUES (ws.workspace_id, 'sow', v_counter)
    ON CONFLICT (workspace_id, document_type)
    DO UPDATE SET next_number = GREATEST(workspace_document_sequences.next_number, v_counter);
  END LOOP;

  -- Change orders: same approach.
  FOR ws IN SELECT DISTINCT workspace_id FROM public.change_orders WHERE sent_at IS NOT NULL LOOP
    v_counter := 1;
    FOR doc IN
      SELECT id FROM public.change_orders
      WHERE workspace_id = ws.workspace_id AND sent_at IS NOT NULL
      ORDER BY sent_at ASC, created_at ASC
    LOOP
      UPDATE public.change_orders
        SET document_number = 'CO-' || lpad(v_counter::text, 4, '0')
        WHERE id = doc.id AND document_number IS NULL;
      v_counter := v_counter + 1;
    END LOOP;

    INSERT INTO public.workspace_document_sequences (workspace_id, document_type, next_number)
    VALUES (ws.workspace_id, 'co', v_counter)
    ON CONFLICT (workspace_id, document_type)
    DO UPDATE SET next_number = GREATEST(workspace_document_sequences.next_number, v_counter);
  END LOOP;
END $$;
