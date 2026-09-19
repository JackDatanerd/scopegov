-- ============================================================
-- ScopeGov — Migration 058: cron heartbeat state
--
-- FIX (cron audit, section 17 — feature gap, closing pass): none of the
-- crons under app/api/cron/* record anything when they succeed — only
-- ops_alert_state (025_ops_alert_state.sql) exists, and that's written
-- only on a detected *failure* inside guardian-health/billing paths. There
-- was nothing anywhere that would catch a cron simply not firing at all
-- (an entry silently dropped from vercel.json, CRON_SECRET drifting out
-- of sync, a Vercel platform outage) — the failure-alerting this same
-- audit pass adds (lib/utils/cron-alert.ts) only fires from *inside* a
-- run, so it can't see a run that never happened.
--
-- One row per cron, upserted on every successful completion
-- (lib/utils/cron-heartbeat.ts). A separate watchdog cron
-- (app/api/cron/cron-heartbeat-watchdog) compares last_ok_at against each
-- cron's expected cadence and pages ops if one's gone quiet. Same
-- ownership model as ops_alert_state: no workspace/user context, RLS
-- enabled with zero policies, service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cron_heartbeats (
  cron_name   text PRIMARY KEY,
  last_ok_at  timestamptz NOT NULL DEFAULT now(),
  last_result jsonb
);

ALTER TABLE public.cron_heartbeats ENABLE ROW LEVEL SECURITY;
