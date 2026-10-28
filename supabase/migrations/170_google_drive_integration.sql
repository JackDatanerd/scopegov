-- 170: Google Drive archive. Reuses the 165/167 tables:
--   integration_connections  provider 'google_drive' (already allowed): the encrypted Google REFRESH token + the Drive root folder.
--   integration_subscriptions kind 'google_drive': ONE rule per connection = which executed documents to archive.
-- Plus one new table: integration_external_refs, the map between a ScopeGov thing and the Drive object made for it
-- (folders, and a file per archived document). It is what makes archiving idempotent: a retry, a second backfill click or a
-- duplicate event can never put a second copy of the same signed PDF in the agency's Drive.

ALTER TABLE public.integration_subscriptions DROP CONSTRAINT IF EXISTS integration_subscriptions_kind_check;
ALTER TABLE public.integration_subscriptions
  ADD CONSTRAINT integration_subscriptions_kind_check CHECK (kind IN ('webhook', 'zapier', 'slack', 'google_drive'));

-- Signing secret: still mandatory for the kinds that sign; Slack and Drive authenticate with their connection's token instead.
ALTER TABLE public.integration_subscriptions DROP CONSTRAINT IF EXISTS integration_subscriptions_secret_required;
ALTER TABLE public.integration_subscriptions
  ADD CONSTRAINT integration_subscriptions_secret_required CHECK (kind IN ('slack', 'google_drive') OR secret_enc IS NOT NULL);

ALTER TABLE public.integration_subscriptions DROP CONSTRAINT IF EXISTS integration_subscriptions_drive_has_connection;
ALTER TABLE public.integration_subscriptions
  ADD CONSTRAINT integration_subscriptions_drive_has_connection CHECK (kind <> 'google_drive' OR connection_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS integration_subscriptions_drive_one
  ON public.integration_subscriptions (connection_id) WHERE kind = 'google_drive';

CREATE TABLE IF NOT EXISTS public.integration_external_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.integration_connections(id) ON DELETE CASCADE,
  ref_type      text NOT NULL CHECK (ref_type IN ('folder', 'file')),
  local_key     text NOT NULL CHECK (char_length(local_key) BETWEEN 1 AND 200),
  remote_id     text NOT NULL CHECK (char_length(remote_id) BETWEEN 1 AND 200),
  remote_name   text,
  remote_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, ref_type, local_key)
);
CREATE INDEX IF NOT EXISTS integration_external_refs_workspace ON public.integration_external_refs (workspace_id);

ALTER TABLE public.integration_external_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_external_refs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.integration_external_refs TO service_role;
