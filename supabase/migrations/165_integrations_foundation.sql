-- 165: integrations foundation.
--
-- Shared plumbing for every outbound integration (generic signed webhooks now; Zapier, Slack, HubSpot and Google Drive
-- build on it):
--   integration_connections   one row per connected third party (OAuth tokens live ENCRYPTED in credentials_enc)
--   integration_api_keys      workspace API keys (stored as a SHA-256 hash; the secret is shown once)
--   integration_subscriptions where events are delivered (a signed webhook URL; the signing secret is encrypted)
--   integration_events        the outbox: one row per business event worth telling the outside world about
--   integration_deliveries    one row per (event, subscription): the retry queue the delivery cron drains
--
-- Every table has RLS enabled and NO policies: they are reachable only through the service-role client, exactly like
-- workspace_secrets. A signed-in member must not be able to read another integration's credentials, or forge an event,
-- through PostgREST.

-- ── connections ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.integration_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('slack', 'zapier', 'hubspot', 'google_drive')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  display_name    text,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  credentials_enc text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  last_error_at   timestamptz,
  UNIQUE (workspace_id, provider)
);

-- ── API keys ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.integration_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  key_prefix   text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS integration_api_keys_workspace ON public.integration_api_keys (workspace_id, created_at DESC);

-- ── subscriptions (delivery targets) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.integration_subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id        uuid REFERENCES public.integration_connections(id) ON DELETE CASCADE,
  kind                 text NOT NULL DEFAULT 'webhook' CHECK (kind IN ('webhook', 'zapier', 'slack')),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  target_url           text NOT NULL CHECK (char_length(target_url) <= 2048),
  event_types          text[] NOT NULL DEFAULT '{}',
  secret_enc           text NOT NULL,
  active               boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_reason      text,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_subscriptions_workspace ON public.integration_subscriptions (workspace_id) WHERE active;

-- ── events (the outbox) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.integration_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_type   text NOT NULL,
  entity_type  text,
  entity_id    uuid,
  project_id   uuid,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_events_dedupe ON public.integration_events (workspace_id, event_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS integration_events_created ON public.integration_events (created_at);

-- ── deliveries (the retry queue) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.integration_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES public.integration_subscriptions(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES public.integration_events(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'succeeded', 'dead', 'skipped')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  last_status     integer,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX IF NOT EXISTS integration_deliveries_due ON public.integration_deliveries (next_attempt_at) WHERE status IN ('pending', 'delivering');
CREATE INDEX IF NOT EXISTS integration_deliveries_subscription ON public.integration_deliveries (subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS integration_deliveries_finished ON public.integration_deliveries (created_at) WHERE status IN ('succeeded', 'dead', 'skipped');

-- ── lock the tables down ─────────────────────────────────────────────────────
ALTER TABLE public.integration_connections   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_api_keys      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_deliveries    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.integration_connections, public.integration_api_keys, public.integration_subscriptions,
              public.integration_events, public.integration_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.integration_connections, public.integration_api_keys, public.integration_subscriptions,
             public.integration_events, public.integration_deliveries TO service_role;

-- ── emit: store the event and fan it out, atomically ─────────────────────────
-- Cheap exit when the workspace has no matching subscription (most workspaces, most of the time): nothing is stored.
-- A second emit of the same (workspace, type, entity) inside p_dedupe_minutes is dropped — the same business event is
-- announced from more than one code path (a route and the repair cron that backs it up).
-- Returns the event id, or NULL when nothing was stored.
CREATE OR REPLACE FUNCTION public.emit_integration_event(
  p_workspace_id   uuid,
  p_event_type     text,
  p_entity_type    text,
  p_entity_id      uuid,
  p_project_id     uuid,
  p_data           jsonb,
  p_dedupe_minutes integer DEFAULT 10
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id uuid;
  v_matches  integer;
BEGIN
  SELECT count(*) INTO v_matches
    FROM integration_subscriptions
   WHERE workspace_id = p_workspace_id AND active AND p_event_type = ANY (event_types);
  IF v_matches = 0 THEN RETURN NULL; END IF;

  -- Serialise concurrent emits of the same event so the dedupe check below cannot be raced past.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_event_type || ':' || coalesce(p_entity_id::text, ''), 0));

  IF p_dedupe_minutes > 0 AND EXISTS (
    SELECT 1 FROM integration_events
     WHERE workspace_id = p_workspace_id
       AND event_type = p_event_type
       AND entity_id IS NOT DISTINCT FROM p_entity_id
       AND created_at > now() - make_interval(mins => p_dedupe_minutes)
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO integration_events (workspace_id, event_type, entity_type, entity_id, project_id, data)
  VALUES (p_workspace_id, p_event_type, p_entity_type, p_entity_id, p_project_id, coalesce(p_data, '{}'::jsonb))
  RETURNING id INTO v_event_id;

  INSERT INTO integration_deliveries (workspace_id, subscription_id, event_id)
  SELECT p_workspace_id, s.id, v_event_id
    FROM integration_subscriptions s
   WHERE s.workspace_id = p_workspace_id AND s.active AND p_event_type = ANY (s.event_types);

  RETURN v_event_id;
END;
$$;

-- ── queue a one-off delivery for a single subscription (the "send test event" button) ──
CREATE OR REPLACE FUNCTION public.enqueue_integration_test(p_subscription_id uuid, p_workspace_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM integration_subscriptions WHERE id = p_subscription_id AND workspace_id = p_workspace_id) THEN
    RETURN NULL;
  END IF;
  INSERT INTO integration_events (workspace_id, event_type, entity_type, data)
  VALUES (p_workspace_id, 'integration.test', 'subscription', coalesce(p_data, '{}'::jsonb))
  RETURNING id INTO v_event_id;
  INSERT INTO integration_deliveries (workspace_id, subscription_id, event_id)
  VALUES (p_workspace_id, p_subscription_id, v_event_id);
  RETURN v_event_id;
END;
$$;

-- ── claim: hand due deliveries to exactly one worker ─────────────────────────
-- FOR UPDATE SKIP LOCKED so two overlapping cron runs never take the same row. A row left 'delivering' by a worker
-- that died (function killed mid-request) becomes claimable again after p_stale_seconds.
CREATE OR REPLACE FUNCTION public.claim_integration_deliveries(p_limit integer, p_stale_seconds integer DEFAULT 300)
RETURNS TABLE (
  id uuid, workspace_id uuid, subscription_id uuid, event_id uuid, attempts integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH due AS (
    SELECT d.id
      FROM integration_deliveries d
     WHERE (d.status = 'pending' AND d.next_attempt_at <= now())
        OR (d.status = 'delivering' AND d.claimed_at < now() - make_interval(secs => p_stale_seconds))
     ORDER BY d.next_attempt_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE integration_deliveries d
     SET status = 'delivering', claimed_at = now(), attempts = d.attempts + 1
    FROM due
   WHERE d.id = due.id
  RETURNING d.id, d.workspace_id, d.subscription_id, d.event_id, d.attempts;
$$;

REVOKE ALL ON FUNCTION public.emit_integration_event(uuid, text, text, uuid, uuid, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_integration_test(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_integration_deliveries(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emit_integration_event(uuid, text, text, uuid, uuid, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_integration_test(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_integration_deliveries(integer, integer) TO service_role;
