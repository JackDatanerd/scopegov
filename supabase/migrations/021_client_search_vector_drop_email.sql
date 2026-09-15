-- ============================================================
-- ScopeGov — Migration 021: Stop indexing client email in search_vector
--
-- FIX (re-audit, search section): clients.search_vector indexed the raw
-- email address, even though /api/search already redacts email from the
-- response for anyone without VIEW_CLIENT_DATA (see that route). The
-- value itself never leaked through this — but a user without that
-- permission who already knows (or guesses) a client's email, or even
-- just a domain fragment like "@some-company.com", could use it as a
-- search key to surface that client's name/company, a small crack in a
-- field that's otherwise correctly gated everywhere else in the app.
-- Generated columns can't have their expression altered in place —
-- Postgres requires dropping and re-adding.
-- ============================================================

ALTER TABLE public.clients DROP COLUMN IF EXISTS search_vector;

ALTER TABLE public.clients
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(company_name,''))
  ) STORED;

CREATE INDEX IF NOT EXISTS clients_search ON public.clients USING GIN(search_vector);
