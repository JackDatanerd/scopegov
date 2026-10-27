-- 167: Slack. Reuses the 165 tables: integration_connections (provider 'slack', the encrypted bot token) and
-- integration_subscriptions (kind 'slack' = one routing rule: a channel + the events posted to it).
--
-- Two small schema changes:
--   • subscriptions.config (jsonb): the per-rule settings a signed webhook never needed (channel id / name / privacy).
--   • subscriptions.secret_enc becomes nullable: a Slack rule posts with the connection's token and signs nothing. The
--     invariant for the signed kinds is kept by a CHECK, so a webhook or Zapier row still cannot exist without a secret.
-- And one rule per channel per connection (a rule holds a LIST of events), enforced by a partial unique index.

ALTER TABLE public.integration_subscriptions ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.integration_subscriptions ALTER COLUMN secret_enc DROP NOT NULL;

ALTER TABLE public.integration_subscriptions DROP CONSTRAINT IF EXISTS integration_subscriptions_secret_required;
ALTER TABLE public.integration_subscriptions
  ADD CONSTRAINT integration_subscriptions_secret_required CHECK (kind = 'slack' OR secret_enc IS NOT NULL);

ALTER TABLE public.integration_subscriptions DROP CONSTRAINT IF EXISTS integration_subscriptions_slack_has_connection;
ALTER TABLE public.integration_subscriptions
  ADD CONSTRAINT integration_subscriptions_slack_has_connection CHECK (kind <> 'slack' OR (connection_id IS NOT NULL AND (config ->> 'channel_id') IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS integration_subscriptions_slack_channel
  ON public.integration_subscriptions (connection_id, (config ->> 'channel_id'))
  WHERE kind = 'slack';
