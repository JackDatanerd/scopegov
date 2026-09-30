-- Cron section 17 (independent pass 4, B2) — trial-warning left recipients' real email addresses in audit_log.
--
-- cron/trial-warning wrote `metadata.sent_to = <recipient email>` on every billing.trial_ending_soon audit row and used it
-- as its once-per-person-per-day dedupe key. audit_log is append-only and erase_user_pii() (075/121) never touched
-- `metadata`, so after the day-30 account erasure the person's real address survived on those rows for the life of the
-- workspace. The cron now keys on `metadata.user_id` instead and no longer writes an address.
--
-- This migration rewrites the rows already written: where the address still resolves to a user, `user_id` is added (so a
-- same-day re-run right after deploy still dedupes); the address is then removed from EVERY such row, including those of
-- accounts that were already erased (their address no longer resolves, so nothing is lost but the PII).
-- audit_log is append-only, so the transaction-local bypass purge_workspace / erase_user_pii use is switched on for exactly
-- this UPDATE and off again. Idempotent: rows without `sent_to` are not touched.

DO $$
BEGIN
  PERFORM set_config('app.audit_purge', 'on', true);

  UPDATE public.audit_log a
     SET metadata = a.metadata || jsonb_build_object('user_id', u.id::text)
    FROM public.users u
   WHERE a.event_type = 'billing.trial_ending_soon'
     AND a.metadata ? 'sent_to'
     AND NOT (a.metadata ? 'user_id')
     AND lower(u.email) = lower(a.metadata ->> 'sent_to');

  UPDATE public.audit_log
     SET metadata = metadata - 'sent_to'
   WHERE event_type = 'billing.trial_ending_soon'
     AND metadata ? 'sent_to';

  PERFORM set_config('app.audit_purge', 'off', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.audit_purge', 'off', true);
  RAISE;
END $$;
