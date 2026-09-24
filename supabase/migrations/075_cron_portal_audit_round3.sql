-- ============================================================
-- ScopeGov — Migration 075: cron + portal audit, round 3
--
-- Apply BEFORE deploying the matching code: notification-cleanup and the cron history writer call objects
-- created here (a missing table is tolerated by the history writer, but notification-cleanup will report the
-- missing function/table as a failed step until this has run).
--
--   1. cron_run_history          per-run history (outcome, duration, counters, error) — see lib/utils/cron-history.ts
--   2. prune_snapshot_history()  month-start downsampling of the two nightly snapshot tables
--   3. erase_user_pii()          account erasure that also reaches audit_log actor PII and auth.identities
--   4. invoices.payment_claim_*  the client's "I've paid" notice from the invoice portal
-- ============================================================

-- ── 1. cron_run_history ─────────────────────────────────────────────────
-- cron_heartbeats keeps exactly one row per cron (the LAST success), so a cron that fails every third run, one
-- creeping toward maxDuration, or one finishing "ok" with row errors all week left no evidence at all.
CREATE TABLE IF NOT EXISTS public.cron_run_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cron_name   text        NOT NULL,
  ok          boolean     NOT NULL,
  duration_ms integer,
  result      jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cron_run_history_name_created
  ON public.cron_run_history (cron_name, created_at DESC);
CREATE INDEX IF NOT EXISTS cron_run_history_created
  ON public.cron_run_history (created_at);
ALTER TABLE public.cron_run_history ENABLE ROW LEVEL SECURITY;
-- Service role only (no policies) — same ownership model as cron_heartbeats / ops_alert_state.
REVOKE ALL ON public.cron_run_history FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.cron_run_history IS
  'One row per cron run (success or failure). Written by lib/utils/cron-history.ts, pruned to 60 days by api/cron/notification-cleanup. Ops query: SELECT cron_name, ok, duration_ms, error, created_at FROM cron_run_history WHERE NOT ok ORDER BY created_at DESC;';

-- ── 2. Snapshot downsampling ────────────────────────────────────────────
-- scope_health_snapshots grows workspaces x days and contract_reconciliation_snapshots projects x days, with no
-- retention anywhere. Daily granularity is only ever charted for the recent window, so older than
-- p_keep_daily_days only the month-start row is kept.
CREATE OR REPLACE FUNCTION public.prune_snapshot_history(p_keep_daily_days integer DEFAULT 400)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cutoff date;
  v_health integer := 0;
  v_recon  integer := 0;
BEGIN
  -- A typo'd tiny window must not be able to wipe recent history.
  IF p_keep_daily_days IS NULL OR p_keep_daily_days < 90 THEN
    RAISE EXCEPTION 'prune_snapshot_history: p_keep_daily_days must be >= 90 (got %)', p_keep_daily_days;
  END IF;
  v_cutoff := CURRENT_DATE - p_keep_daily_days;

  DELETE FROM public.scope_health_snapshots
   WHERE snapshot_date < v_cutoff AND EXTRACT(DAY FROM snapshot_date) <> 1;
  GET DIAGNOSTICS v_health = ROW_COUNT;

  DELETE FROM public.contract_reconciliation_snapshots
   WHERE snapshot_date < v_cutoff AND EXTRACT(DAY FROM snapshot_date) <> 1;
  GET DIAGNOSTICS v_recon = ROW_COUNT;

  RETURN jsonb_build_object('scope_health', v_health, 'reconciliation', v_recon, 'before', v_cutoff);
END;
$$;
REVOKE ALL ON FUNCTION public.prune_snapshot_history(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_snapshot_history(integer) TO service_role;

-- ── 3. Account erasure that reaches the rest of the PII ─────────────────
-- The day-30 erasure (api/cron/invite-cleanup -> lib/utils/account-erasure.ts) anonymized public.users and the
-- auth record, but left the person's email, display name and IP address in audit_log (actor_email / actor_name /
-- ip_address are denormalized onto every row and audit_log is append-only, retained for the life of the
-- workspace), left their notifications, and — a documented limit until now — left the OAuth provider's copy of
-- their email and name in auth.identities (the GoTrue admin API has no call to remove it).
--
-- audit_log stays append-only for everyone else: the same 'app.audit_purge' transaction-local switch that
-- purge_workspace() uses is turned on for exactly these UPDATEs and off again. The rows themselves (who did what,
-- when) are kept — pseudonymized to the same placeholder the users row gets, keyed by actor_id.
CREATE OR REPLACE FUNCTION public.erase_user_pii(p_user_id uuid, p_email text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_audit       integer := 0;
  v_target      integer := 0;
  v_notes       integer := 0;
  v_identities  integer := 0;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'erase_user_pii: p_user_id is required'; END IF;

  PERFORM set_config('app.audit_purge', 'on', true);
  BEGIN
    UPDATE public.audit_log
       SET actor_email = 'deleted-' || p_user_id::text || '@deleted.scopegov.app',
           actor_name  = '[Deleted user]',
           ip_address  = NULL
     WHERE actor_id = p_user_id
       AND (actor_name <> '[Deleted user]' OR ip_address IS NOT NULL
            OR actor_email <> 'deleted-' || p_user_id::text || '@deleted.scopegov.app');
    GET DIAGNOSTICS v_audit = ROW_COUNT;

    -- Events ABOUT the person (an invite or role change names them as the entity) — matched on their old
    -- login email, and only within workspaces they were a member of, so this never scans the whole table.
    IF p_email IS NOT NULL AND length(btrim(p_email)) > 3 THEN
      UPDATE public.audit_log
         SET entity_name = '[Deleted user]'
       WHERE lower(entity_name) = lower(btrim(p_email))
         AND workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = p_user_id);
      GET DIAGNOSTICS v_target = ROW_COUNT;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.audit_purge', 'off', true);
    RAISE;
  END;
  PERFORM set_config('app.audit_purge', 'off', true);

  -- Their own bell: nobody else can see it, and the titles/bodies routinely carry names.
  DELETE FROM public.notifications WHERE recipient_id = p_user_id;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  -- OAuth identities hold the provider's copy of the email / name (identity_data).
  DELETE FROM auth.identities WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_identities = ROW_COUNT;

  RETURN jsonb_build_object(
    'audit_actor_rows', v_audit, 'audit_target_rows', v_target,
    'notifications', v_notes, 'identities', v_identities
  );
END;
$$;
REVOKE ALL ON FUNCTION public.erase_user_pii(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_user_pii(uuid, text) TO service_role;

-- ── 4. Client "I've paid" notice ────────────────────────────────────────
-- The invoice portal only let a client dispute an invoice. The far more common message is "I've paid this" —
-- sent long before the agency has reconciled their bank — and until now the client's only options were to
-- email the agency separately or to keep receiving overdue reminders. A claim does NOT mark the invoice paid
-- (only the agency can record a payment); it tells the agency, and pauses the automatic client reminders.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payment_claimed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS payment_claim_reference   text,
  ADD COLUMN IF NOT EXISTS payment_claim_note        text,
  ADD COLUMN IF NOT EXISTS payment_claim_cleared_at  timestamptz;

DO $$ BEGIN
  ALTER TABLE public.invoices
    ADD CONSTRAINT invoices_payment_claim_reference_len CHECK (payment_claim_reference IS NULL OR char_length(payment_claim_reference) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.invoices
    ADD CONSTRAINT invoices_payment_claim_note_len CHECK (payment_claim_note IS NULL OR char_length(payment_claim_note) <= 1000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.invoices.payment_claimed_at IS
  'Set by api/portal/invoice/[token]/paid when the client says they have paid. An OPEN claim = payment_claimed_at set and payment_claim_cleared_at NULL (or older than payment_claimed_at). Cleared automatically when the agency records a payment.';
