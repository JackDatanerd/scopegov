-- 012_ai_rate_limits.sql
--
-- FIX (audit round 3, finding #4): none of the AI-cost routes
-- (sow/parse-brief, sow/generate, sow/regenerate-section, co/draft,
-- guardian/check) had any rate limiting — a single authenticated member
-- could loop a request and run up an unbounded Anthropic bill. No
-- Redis/Upstash is configured for this project, so this is a simple
-- Postgres-backed sliding-window counter: one row per AI call, counted
-- and pruned by lib/utils/rate-limit.ts. Volume is low enough (human-
-- triggered document actions, not a high-QPS path) that a table scan
-- with an index is more than fast enough and avoids adding new infra.

CREATE TABLE IF NOT EXISTS public.ai_usage_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  route_key    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_window
  ON public.ai_usage_log (user_id, route_key, created_at DESC);

-- Cheap periodic cleanup target — the cron sweep in
-- lib/utils/rate-limit.ts / a future cron route can delete rows older
-- than a day; not required for correctness since the window query only
-- ever looks back a few minutes, but keeps the table small.
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created_at
  ON public.ai_usage_log (created_at);

ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies, matching audit_log and every other
-- service-role-only table in 001_initial_schema.sql — RLS with zero
-- policies blocks anon/authenticated entirely; service_role bypasses
-- RLS by default, which is the only client that ever touches this table.
