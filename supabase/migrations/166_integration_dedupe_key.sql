-- 166: fix integration event de-duplication (follow-up to 165).
--
-- 165 dropped a repeat of the same (workspace, event type, entity_id) within 10 minutes, to absorb one business event
-- being announced from two code paths. But nearly every notification is raised against the PROJECT (entity_type
-- 'project', entity_id = project id), not the invoice / SOW / flag itself, so two DIFFERENT events on one project —
-- two invoices paid, two Guardian flags — inside ten minutes were treated as one and the second was silently lost.
--
-- The key now identifies what the event actually says. The app passes the announcement's identifying text (type, entity,
-- title, summary) as p_dedupe_key and the function stores its md5 (raw text could outgrow a btree index row). Two payments
-- of different amounts differ; the same announcement made twice is identical. With no key supplied nothing is
-- de-duplicated: losing an event is worse than sending a duplicate (receivers de-duplicate on the event id anyway).

ALTER TABLE public.integration_events ADD COLUMN IF NOT EXISTS dedupe_key text;

DROP INDEX IF EXISTS public.integration_events_dedupe;
CREATE INDEX IF NOT EXISTS integration_events_dedupe
  ON public.integration_events (workspace_id, event_type, dedupe_key, created_at DESC);

-- Replaced, not overloaded: two same-named functions with different arities make PostgREST rpc() ambiguous.
DROP FUNCTION IF EXISTS public.emit_integration_event(uuid, text, text, uuid, uuid, jsonb, integer);

CREATE OR REPLACE FUNCTION public.emit_integration_event(
  p_workspace_id   uuid,
  p_event_type     text,
  p_entity_type    text,
  p_entity_id      uuid,
  p_project_id     uuid,
  p_data           jsonb,
  p_dedupe_key     text DEFAULT NULL,
  p_dedupe_minutes integer DEFAULT 10
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id uuid;
  v_matches  integer;
  v_key      text := CASE WHEN p_dedupe_key IS NULL THEN NULL ELSE md5(p_dedupe_key) END;
BEGIN
  SELECT count(*) INTO v_matches
    FROM integration_subscriptions
   WHERE workspace_id = p_workspace_id AND active AND p_event_type = ANY (event_types);
  IF v_matches = 0 THEN RETURN NULL; END IF;

  IF v_key IS NOT NULL AND p_dedupe_minutes > 0 THEN
    -- Serialise concurrent emits of the same announcement so the check below cannot be raced past.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_event_type || ':' || v_key, 0));
    IF EXISTS (
      SELECT 1 FROM integration_events
       WHERE workspace_id = p_workspace_id
         AND event_type = p_event_type
         AND dedupe_key = v_key
         AND created_at > now() - make_interval(mins => p_dedupe_minutes)
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO integration_events (workspace_id, event_type, entity_type, entity_id, project_id, data, dedupe_key)
  VALUES (p_workspace_id, p_event_type, p_entity_type, p_entity_id, p_project_id, coalesce(p_data, '{}'::jsonb), v_key)
  RETURNING id INTO v_event_id;

  INSERT INTO integration_deliveries (workspace_id, subscription_id, event_id)
  SELECT p_workspace_id, s.id, v_event_id
    FROM integration_subscriptions s
   WHERE s.workspace_id = p_workspace_id AND s.active AND p_event_type = ANY (s.event_types);

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.emit_integration_event(uuid, text, text, uuid, uuid, jsonb, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emit_integration_event(uuid, text, text, uuid, uuid, jsonb, text, integer) TO service_role;
