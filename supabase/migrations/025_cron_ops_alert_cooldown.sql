-- ============================================================
-- ScopeGov — Migration 025: ops alert cooldown state
--
-- FIX (cron audit, section 17): guardian-health/route.ts's ops alerts had
-- no cooldown at all — every 15-minute run that still saw an elevated
-- classification-failure rate or an unresolved failure older than 24h sent
-- a fresh email to OPS_ALERT_EMAIL. Left unresolved over a weekend that's
-- 190+ near-identical emails for the same underlying issue, unlike every
-- other recurring notification in this codebase (trial-warning, co-stall,
-- sow-stall, etc.), which all de-dupe against a prior send.
--
-- audit_log can't hold this: workspace_id is NOT NULL there (001_initial_
-- schema.sql), and this health check is platform-wide, not scoped to a
-- workspace. This is a minimal singleton-per-alert-key table instead — no
-- workspace/user context needed, just "when did we last actually send
-- this alert". RLS is enabled with no policies (same pattern as
-- scope_health_snapshots in 007_scope_health.sql): only the service role
-- (used exclusively by cron routes) can touch it.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ops_alert_state (
  key           text PRIMARY KEY,
  last_sent_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ops_alert_state ENABLE ROW LEVEL SECURITY;
