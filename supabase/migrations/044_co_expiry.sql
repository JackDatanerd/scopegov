-- ============================================================
-- ScopeGov — Migration 044: change order expiry
--
-- FEATURE GAP (section-10 audit, CO logic deep pass): sow_documents has
-- had a first-class 'expired' status (and a cron that sets it — see
-- cron/sow-expiry's own header comment for that fix's history) since
-- early on. change_orders never got the equivalent: its status CHECK
-- constraint has no 'expired' value, and there is no co-expiry cron —
-- only co-stall (5 days). A CO's signing JWT still dies cryptographically
-- at 30 days (expires_at) regardless — the Remind route already guards
-- against emailing a dead link — but the DB status just sits wherever
-- co-stall last left it ('stalled') forever, with a dead, never-revoked
-- token sitting on the row and zero proactive signal to the agency short
-- of a blocked Remind attempt.
--
-- This adds the status value; app/api/cron/co-expiry does the sweep,
-- mirroring cron/sow-expiry exactly (CAS on the status read, revoke the
-- token, audit-log, notify).
-- ============================================================

ALTER TABLE public.change_orders DROP CONSTRAINT IF EXISTS change_orders_status_check;
ALTER TABLE public.change_orders ADD CONSTRAINT change_orders_status_check
  CHECK (status IN ('draft','awaiting_response','accepted','declined',
                     'countered','closed','stalled','withdrawn','exception_granted',
                     'awaiting_countersignature','expired'));
