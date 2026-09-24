-- ============================================================
-- 073 — accent-insensitive search text for client contacts
--
-- /api/search matched contact names with a plain, accent-SENSITIVE ilike, so
-- "jose" never found "José" although projects and clients (migration 062)
-- already fold accents. Same generated-column + trigram-index approach.
-- Name, e-mail and role are folded into one column so a single indexed
-- substring match covers what used to be two queries.
--
-- Depends on public.immutable_unaccent() from migration 062. Idempotent.
-- Deploy order: apply this BEFORE (or with) the search route that reads it —
-- until then the contacts block reports itself as `partial` instead of
-- returning results.
-- ============================================================
DO $$
DECLARE
  tg_schema text;
BEGIN
  IF to_regprocedure('public.immutable_unaccent(text)') IS NULL THEN
    RAISE EXCEPTION 'public.immutable_unaccent(text) is missing — apply migration 062 first';
  END IF;
  SELECT n.nspname INTO tg_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';

  EXECUTE 'ALTER TABLE public.client_contacts ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (lower(public.immutable_unaccent(coalesce(name, '''') || '' '' || coalesce(email, '''') || '' '' || coalesce(role, '''')))) STORED';
  EXECUTE format('CREATE INDEX IF NOT EXISTS client_contacts_search_text_trgm ON public.client_contacts USING GIN (search_text %I.gin_trgm_ops)', tg_schema);
END $$;
