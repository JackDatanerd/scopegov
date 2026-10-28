-- 169_ai_usage_allowance_bucket.sql
--
-- Tiers & pricing independent pass: two defects in the monthly AI drafting allowance (migration 168 / lib/utils/rate-limit.ts).
--
--  B1  An internal retry (sow/generate asks the model again when a reply fails validation) wrote another usage row, and a call
--      that failed outright still spent the allowance, so one click could use up to 3 of a customer's monthly drafts.
--  B2  The count was "this calendar month, whatever plan it was on", so a trialist who had used 100 drafts (the trial allows
--      600) subscribed to Solo (60) and was refused for the rest of the month, with a message telling them to upgrade.
--
-- Every usage row now says which allowance it spends:
--   'trial'  written while the workspace is on its trial        -> counted against the trial's allowance only
--   'paid'   written on a paid plan (also the default, which is what rows from before this migration are)
--   'none'   an internal retry, or a call that failed and was refunded -> still in the log (the 10-minute burst limit and the
--            cost trail keep seeing it) but never counted against the allowance
--
-- Safe before or after the code deploy: until the column exists the code falls back to the old insert, and the monthly count
-- fails open instead of erroring.

ALTER TABLE public.ai_usage_log
  ADD COLUMN IF NOT EXISTS allowance_bucket text NOT NULL DEFAULT 'paid'
  CHECK (allowance_bucket IN ('trial', 'paid', 'none'));

-- Serves: WHERE workspace_id = $1 AND allowance_bucket = $2 AND route_key IN (...) AND created_at >= <first of the month>.
-- Replaces the index migration 168 added for the same count before the bucket existed.
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_workspace_bucket_month
  ON public.ai_usage_log (workspace_id, allowance_bucket, route_key, created_at DESC);
DROP INDEX IF EXISTS public.idx_ai_usage_log_workspace_month;
