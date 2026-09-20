-- ============================================================
-- ScopeGov — Migration 062: Notifications, email delivery, search
--
-- Notifications & email / Search fix round.
--
--  1. workspaces.reply_to_email  — Reply-To for client-facing email. Every
--     client email used to come from noreply@ with no way to answer it.
--  2. email_log                  — one row per tracked outbound email, so a
--     provider bounce/complaint (Resend webhook) can be traced back to the
--     document and person that sent it. Service-role only.
--  3. notifications indexes      — the only index was partial (read = false),
--     so the bell's "latest 50" query and the retention sweep had none.
--  4. search_text columns         — accent-insensitive, substring-searchable
--     text for projects and clients (+ pg_trgm indexes). Replaces the
--     stemmed tsvector prefix search, which lost matches mid-typing
--     ("marketi"), could not find names with ' or & (O'Brien, R&D), and
--     ignored stop words ("an", "on").
--
-- Idempotent. The old search_vector columns are left in place so an older
-- deploy keeps working during rollout; they can be dropped in a later
-- migration once nothing reads them.
-- ============================================================

-- ── 1. Reply-To ────────────────────────────────────────────────
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS reply_to_email text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_reply_to_email_format') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_reply_to_email_format
      CHECK (reply_to_email IS NULL OR (length(reply_to_email) <= 254 AND reply_to_email ~ '^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$'));
  END IF;
END $$;

-- ── 2. email_log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL,                 -- 'sow.send', 'invoice.reminder', …
  entity_type  text,
  entity_id    uuid,
  project_id   uuid,
  actor_id     uuid,                          -- who triggered it (notified on bounce)
  to_emails    text[] NOT NULL DEFAULT '{}',
  cc_emails    text[] NOT NULL DEFAULT '{}',
  subject      text,
  provider_id  text,                          -- Resend email id
  status       text NOT NULL DEFAULT 'sent'
               CHECK (status IN ('sent','delivered','delayed','bounced','complained','failed')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_log_provider_id ON public.email_log(provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_log_workspace   ON public.email_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_log_entity      ON public.email_log(entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_log_created     ON public.email_log(created_at);

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.email_log TO service_role;

-- ── 3. notifications indexes ───────────────────────────────────
-- Bell / inbox list (read AND unread), newest first.
CREATE INDEX IF NOT EXISTS notifications_recipient_all
  ON public.notifications(recipient_id, workspace_id, created_at DESC);
-- Retention sweep (cron/notification-cleanup) filters on age.
CREATE INDEX IF NOT EXISTS notifications_created_at
  ON public.notifications(created_at);

-- ── 4. Search ──────────────────────────────────────────────────
-- Resolve where pg_trgm / unaccent live (Supabase keeps extensions in the
-- "extensions" schema; a plain Postgres may use public) and build the
-- objects against that schema instead of assuming one.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

DO $$
DECLARE
  ua_schema text;
  tg_schema text;
BEGIN
  SELECT n.nspname INTO ua_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent';
  SELECT n.nspname INTO tg_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';

  -- unaccent() is only STABLE, which generated columns and indexes reject.
  -- The dictionary is fixed, so wrapping it as IMMUTABLE is the standard,
  -- safe workaround.
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION public.immutable_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    AS $body$ SELECT %1$I.unaccent('%1$I.unaccent'::regdictionary, $1) $body$
  $f$, ua_schema);

  EXECUTE 'ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (lower(public.immutable_unaccent(coalesce(name, '''') || '' '' || coalesce(disc, '''')))) STORED';
  EXECUTE 'ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS search_text text
    GENERATED ALWAYS AS (lower(public.immutable_unaccent(coalesce(name, '''') || '' '' || coalesce(company_name, '''')))) STORED';

  EXECUTE format('CREATE INDEX IF NOT EXISTS projects_search_text_trgm ON public.projects USING GIN (search_text %I.gin_trgm_ops)', tg_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS clients_search_text_trgm  ON public.clients  USING GIN (search_text %I.gin_trgm_ops)', tg_schema);
END $$;

-- (The search route normalises the user's query in application code with the
-- same rules, so "Café" finds "Cafe" and vice-versa — see lib/search/query.ts.)
