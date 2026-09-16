-- ============================================================
-- ScopeGov — Migration 030: portal action rate limiting
--
-- FEATURE (portal audit, section 18): none of the public, unauthenticated
-- POST endpoints under api/portal/{sow,co}/[token]/* (sign, decline,
-- request-changes, accept, counter, countersign) had any rate limiting —
-- the single most exposed write surface in the app, gated purely by
-- possession of a long random signed token rather than a login. Practical
-- risk is low (the token itself isn't guessable), but there's zero
-- defense-in-depth today against automated hammering of an endpoint if a
-- token ever does leak (forwarded email, shared-machine browser history,
-- a referrer header). Same Postgres-backed sliding-window approach as
-- lib/utils/rate-limit.ts (012_ai_rate_limits.sql) — keyed by client IP
-- since there's no authenticated user_id here, and generous, matching
-- that file's own "backstop, not a product throttle" philosophy.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.portal_action_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip         text NOT NULL,
  route_key  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_action_log_window
  ON public.portal_action_log (ip, route_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_portal_action_log_created_at
  ON public.portal_action_log (created_at);

ALTER TABLE public.portal_action_log ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies — service role only, same pattern as
-- ai_usage_log and every other cron/service-only table.
