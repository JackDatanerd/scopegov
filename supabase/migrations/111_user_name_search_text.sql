-- ============================================================
-- 111 — accent-insensitive search text for user names (team-member search)
--
-- /api/search's "members" block (added in the Search fix round, round 2)
-- matched team-member names with a plain, accent-SENSITIVE ilike — the same
-- gap migrations 062 and 073 already closed for projects, clients and
-- client_contacts ("jose" never found "José"), just never propagated to
-- users when member search was bolted on afterwards. Same generated-column
-- + trigram-index approach as those two.
--
-- Depends on public.immutable_unaccent() from migration 062. Idempotent.
-- Deploy order: apply this BEFORE (or with) the search route that reads it —
-- until then the members block keeps working off the raw `name` column
-- (accent-sensitive, as before), it just doesn't regress anything.
-- ============================================================
DO $$
DECLARE
  tg_schema text;
BEGIN
  IF to_regprocedure('public.immutable_unaccent(text)') IS NULL THEN
    RAISE EXCEPTION 'public.immutable_unaccent(text) is missing — apply migration 062 first';
  END IF;
  SELECT n.nspname INTO tg_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';

  EXECUTE 'ALTER TABLE public.users ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (lower(public.immutable_unaccent(coalesce(name, '''')))) STORED';
  EXECUTE format('CREATE INDEX IF NOT EXISTS users_search_text_trgm ON public.users USING GIN (search_text %I.gin_trgm_ops)', tg_schema);
END $$;
