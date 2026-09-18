-- ============================================================
-- ScopeGov — Migration 047: billing plan interval
--
-- FEATURE GAP (deep audit, Billing re-pass): billing.payment_method_last4/
-- payment_method_type (001_initial_schema.sql) already anticipated
-- surfacing card-on-file details, but there was no equivalent column for
-- which billing interval (monthly/annual) a workspace is actually on —
-- app/api/billing/upgrade/route.ts accepts an `interval` and maps it to a
-- distinct Paystack plan code per (planKey, interval) pair, but nothing
-- ever recorded which one a workspace ended up subscribed to. Settings →
-- Billing (components/settings/SettingsClient.tsx) could therefore never
-- tell "already on Pro monthly" apart from "already on Pro annual" — it
-- only ever compared plan_tier, so the current-tier's card always showed
-- static "Current plan" text with no way to switch interval at all, even
-- though the backend already fully supports checking out a different
-- interval on the same tier.
--
-- Populated by api/billing/webhook/route.ts's subscription.create handler
-- (derived from the plan code, the same way planCodeToTier already is).
-- ============================================================

ALTER TABLE public.billing
  ADD COLUMN IF NOT EXISTS plan_interval text CHECK (plan_interval IN ('monthly', 'annual'));
