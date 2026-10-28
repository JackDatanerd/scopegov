-- 168_ai_usage_monthly_allowance.sql
--
-- Tiers & pricing round: each plan now includes a monthly allowance of AI drafts, counted from ai_usage_log per workspace
-- (lib/utils/rate-limit.ts getAiDraftUsage / claimAiRateSlot). The only indexes on this table are keyed by user_id or
-- project_id, so a per-workspace monthly count would scan. This one serves exactly that query:
--   WHERE workspace_id = $1 AND route_key IN (...) AND created_at >= <first of the month>
--
-- No data change, safe to run before or after the code deploy (until the index exists the count is merely slower).

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_workspace_month
  ON public.ai_usage_log (workspace_id, route_key, created_at DESC);
