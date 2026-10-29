-- 171: HubSpot CRM sync. Reuses the 165/167/170 tables:
--   integration_connections   provider 'hubspot' (already allowed): the encrypted HubSpot REFRESH token + portal info.
--   integration_subscriptions kind 'hubspot': ONE rule per connection = which events to sync + {pipeline_id, include_amounts}.
--   integration_external_refs the Company / Contact / Deal / Note ids ScopeGov made in HubSpot, so a sync is idempotent.
-- Changes: allow kind 'hubspot' (it has no signing secret and needs a connection, like Slack and Drive), allow the four new ref types,
-- and index note refs by age so the nightly cleanup can drop them (a note ref only has to outlive that event's retries).

ALTER TABLE public.integration_subscriptions DROP CONSTRAINT IF EXISTS integration_subscriptions_kind_check;
ALTER TABLE public.integration_subscriptions
  ADD CONSTRAINT integration_subscriptions_kind_check CHECK (kind IN ('webhook', 'zapier', 'slack', 'google_drive', 'hubspot'));

ALTER TABLE public.integration_subscriptions DROP CONSTRAINT IF EXISTS integration_subscriptions_secret_required;
ALTER TABLE public.integration_subscriptions
  ADD CONSTRAINT integration_subscriptions_secret_required CHECK (kind IN ('slack', 'google_drive', 'hubspot') OR secret_enc IS NOT NULL);

ALTER TABLE public.integration_subscriptions DROP CONSTRAINT IF EXISTS integration_subscriptions_hubspot_has_connection;
ALTER TABLE public.integration_subscriptions
  ADD CONSTRAINT integration_subscriptions_hubspot_has_connection CHECK (kind <> 'hubspot' OR connection_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS integration_subscriptions_hubspot_one
  ON public.integration_subscriptions (connection_id) WHERE kind = 'hubspot';

ALTER TABLE public.integration_external_refs DROP CONSTRAINT IF EXISTS integration_external_refs_ref_type_check;
ALTER TABLE public.integration_external_refs
  ADD CONSTRAINT integration_external_refs_ref_type_check CHECK (ref_type IN ('folder', 'file', 'company', 'contact', 'deal', 'note'));

CREATE INDEX IF NOT EXISTS integration_external_refs_notes_age
  ON public.integration_external_refs (created_at) WHERE ref_type = 'note';
