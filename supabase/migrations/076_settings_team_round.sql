-- ============================================================
-- 076 — Settings & Team round
--
--  1. workspaces.default_tax_rate / default_tax_inclusive /
--     default_payment_terms_days — workspace-level billing defaults
--     that pre-fill every new invoice and change order (Settings →
--     Workspace → Billing defaults). Before this every invoice started
--     at 0% tax with a blank due date.
--  2. workspace_document_sequences.prefix + set_document_sequence() —
--     lets an agency set its own document prefix (SOW-/CO-/INV-) and the
--     next number, so an agency moving over from another tool can carry
--     its numbering on (INV-0120 → INV-0121). The function refuses any
--     next number that would collide with a number already issued under
--     the same prefix, atomically with the sequence row lock.
--  3. assign_document_number(): honours the custom prefix, and no longer
--     truncates numbers past 9999 (lpad(text, 4) CUTS a longer string
--     down to 4 characters — number 10000 came back as "…-1000").
-- ============================================================

-- ── 1. billing defaults ──────────────────────────────────────
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS default_tax_rate           numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS default_tax_inclusive      boolean      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS default_payment_terms_days integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_tax_rate_range') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_default_tax_rate_range CHECK (default_tax_rate >= 0 AND default_tax_rate <= 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_payment_terms_days_range') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_default_payment_terms_days_range
      CHECK (default_payment_terms_days IS NULL OR (default_payment_terms_days >= 0 AND default_payment_terms_days <= 365));
  END IF;
END $$;

-- ── 2. document numbering: custom prefix ─────────────────────
ALTER TABLE public.workspace_document_sequences
  ADD COLUMN IF NOT EXISTS prefix text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_document_sequences_prefix_format') THEN
    ALTER TABLE public.workspace_document_sequences
      ADD CONSTRAINT workspace_document_sequences_prefix_format
      CHECK (prefix IS NULL OR prefix ~ '^[A-Z0-9]([A-Z0-9-]{0,10}[A-Z0-9])?$');
  END IF;
END $$;

-- ── 3. generator: custom prefix + no truncation past 9999 ────
CREATE OR REPLACE FUNCTION public.assign_document_number(
  p_workspace_id  uuid,
  p_document_type text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_next   integer;
  v_custom text;
  v_prefix text;
  v_digits text;
BEGIN
  IF p_document_type NOT IN ('sow','co','invoice') THEN
    RAISE EXCEPTION 'Invalid document_type: %', p_document_type;
  END IF;

  -- Same atomic claim-and-increment as 003; additionally hands back the
  -- workspace's custom prefix (NULL = use the default for the type).
  INSERT INTO public.workspace_document_sequences AS s (workspace_id, document_type, next_number)
  VALUES (p_workspace_id, p_document_type, 2)
  ON CONFLICT (workspace_id, document_type)
  DO UPDATE SET next_number = s.next_number + 1, updated_at = now()
  RETURNING (CASE WHEN xmax = 0 THEN 1 ELSE s.next_number - 1 END), s.prefix
  INTO v_next, v_custom;

  v_prefix := COALESCE(v_custom, CASE p_document_type
    WHEN 'sow'     THEN 'SOW'
    WHEN 'co'      THEN 'CO'
    WHEN 'invoice' THEN 'INV'
  END);

  v_digits := v_next::text;
  IF length(v_digits) < 4 THEN
    v_digits := lpad(v_digits, 4, '0');
  END IF;

  RETURN v_prefix || '-' || v_digits;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_document_number(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_document_number(uuid, text) TO service_role;

-- ── 4. settable sequence ─────────────────────────────────────
-- Locks the sequence row (the same row assign_document_number() updates),
-- then checks the requested next number against every number already
-- issued under the same prefix, so a live send can never race the change
-- into a duplicate. Raises 'next_number_too_low:<minimum>' on collision.
CREATE OR REPLACE FUNCTION public.set_document_sequence(
  p_workspace_id  uuid,
  p_document_type text,
  p_prefix        text,
  p_next_number   integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_default text;
  v_prefix  text;
  v_max     bigint;
BEGIN
  IF p_document_type NOT IN ('sow','co','invoice') THEN
    RAISE EXCEPTION 'Invalid document_type: %', p_document_type;
  END IF;

  v_default := CASE p_document_type WHEN 'sow' THEN 'SOW' WHEN 'co' THEN 'CO' ELSE 'INV' END;
  v_prefix  := COALESCE(NULLIF(btrim(p_prefix), ''), v_default);

  IF v_prefix !~ '^[A-Z0-9]([A-Z0-9-]{0,10}[A-Z0-9])?$' THEN
    RAISE EXCEPTION 'invalid_prefix';
  END IF;
  IF p_next_number IS NULL OR p_next_number < 1 OR p_next_number > 99999999 THEN
    RAISE EXCEPTION 'invalid_next_number';
  END IF;

  INSERT INTO public.workspace_document_sequences (workspace_id, document_type, next_number)
  VALUES (p_workspace_id, p_document_type, 1)
  ON CONFLICT (workspace_id, document_type) DO NOTHING;

  PERFORM 1 FROM public.workspace_document_sequences
   WHERE workspace_id = p_workspace_id AND document_type = p_document_type
   FOR UPDATE;

  SELECT COALESCE(MAX(((regexp_match(n, '^' || v_prefix || '-([0-9]{1,9})$'))[1])::bigint), 0)
    INTO v_max
    FROM (
      SELECT document_number AS n FROM public.sow_documents
       WHERE workspace_id = p_workspace_id AND p_document_type = 'sow'
      UNION ALL
      SELECT document_number FROM public.change_orders
       WHERE workspace_id = p_workspace_id AND p_document_type = 'co'
      UNION ALL
      SELECT invoice_number FROM public.invoices
       WHERE workspace_id = p_workspace_id AND p_document_type = 'invoice'
    ) t
   WHERE n IS NOT NULL;

  IF p_next_number <= v_max THEN
    RAISE EXCEPTION 'next_number_too_low:%', v_max + 1;
  END IF;

  UPDATE public.workspace_document_sequences
     SET prefix      = CASE WHEN v_prefix = v_default THEN NULL ELSE v_prefix END,
         next_number = p_next_number,
         updated_at  = now()
   WHERE workspace_id = p_workspace_id AND document_type = p_document_type;

  RETURN jsonb_build_object('prefix', v_prefix, 'next_number', p_next_number);
END;
$$;

REVOKE ALL ON FUNCTION public.set_document_sequence(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_document_sequence(uuid, text, text, integer) TO service_role;
