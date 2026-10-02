-- ============================================================
-- 137 — accent-insensitive search text for change-order titles, invoice
--       titles and Guardian flag descriptions / SOW references
--
-- /api/search matched projects, clients, contacts and team members on
-- accent-folded search_text columns (migrations 062 / 073 / 111), but its
-- change-order, invoice and flag blocks still ran a plain, accent-SENSITIVE
-- ilike against the raw title / description / sow_reference. "cafe" never
-- found a change order titled "Café extras" (and "café" never found
-- "Cafe extras") unless the project's own name happened to match too.
-- Same generated-column + trigram-index approach as those migrations.
--
-- Depends on public.immutable_unaccent() from migration 062. Idempotent.
-- Deploy order: apply this BEFORE (or with) the search route that reads it —
-- until then the change orders / invoices / flags blocks report themselves as
-- `partial` instead of returning results.
-- ============================================================
DO $$
DECLARE
  tg_schema text;
BEGIN
  IF to_regprocedure('public.immutable_unaccent(text)') IS NULL THEN
    RAISE EXCEPTION 'public.immutable_unaccent(text) is missing — apply migration 062 first';
  END IF;
  SELECT n.nspname INTO tg_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';

  EXECUTE 'ALTER TABLE public.change_orders ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (lower(public.immutable_unaccent(coalesce(title, '''')))) STORED';
  EXECUTE 'ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (lower(public.immutable_unaccent(coalesce(title, '''')))) STORED';
  -- Flags: the description plus the SOW clause they cite (the palette matched both).
  EXECUTE 'ALTER TABLE public.guardian_flags ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (lower(public.immutable_unaccent(coalesce(description, '''') || '' '' || coalesce(sow_reference, '''')))) STORED';

  EXECUTE format('CREATE INDEX IF NOT EXISTS change_orders_search_text_trgm ON public.change_orders USING GIN (search_text %I.gin_trgm_ops)', tg_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS invoices_search_text_trgm      ON public.invoices      USING GIN (search_text %I.gin_trgm_ops)', tg_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS guardian_flags_search_text_trgm ON public.guardian_flags USING GIN (search_text %I.gin_trgm_ops)', tg_schema);
END $$;
