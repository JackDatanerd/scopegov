-- ============================================================
-- 056 — Sections 15 (Reports & Audit log) + 16 (Billing) audit
--
-- (1) audit_log.project_id
--     The audit export's project filter used to resolve entity_ids from live
--     tables at query time (sow_documents / change_orders / guardian_* /
--     exceptions_log). That is structurally lossy: invoices, project
--     messages and payment milestones were never resolved, hard-deleted rows
--     can't be resolved at all, and `.in('entity_id', [hundreds of UUIDs])`
--     goes into the request URL. The project is now recorded on the row at
--     write time. A BEFORE INSERT trigger derives it from entity_type /
--     entity_id (falling back to metadata.project_id), so every existing
--     logAudit() call site, every direct audit_log insert, and every future
--     one is covered without touching them. No FK on purpose: audit rows
--     must outlive a purged project.
--
-- (2) audit_log is append-only
--     The UI calls it an "immutable record" but service_role had GRANT ALL
--     and nothing blocked UPDATE/DELETE/TRUNCATE. Triggers now reject them.
--     purge_workspace() (the one legitimate deleter, years after a workspace
--     is deleted) sets a transaction-local flag to get through.
--
-- (3) processed_webhook_events becomes a claim table
--     The Paystack webhook inserted its idempotency key BEFORE processing
--     and never released it, so any failure after the insert made every
--     retry a "duplicate" and the payment event was lost for good. Rows now
--     carry a status ('processing' | 'done') and a claimed_at so a failed or
--     crashed attempt can be released / taken over.
-- ============================================================

-- ── (1) audit_log.project_id ────────────────────────────────────────────
ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS project_id uuid;

CREATE OR REPLACE FUNCTION public.audit_resolve_project_id(
  p_entity_type text,
  p_entity_id   uuid,
  p_metadata    jsonb
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v uuid;
  m text;
BEGIN
  IF p_entity_id IS NOT NULL THEN
    CASE p_entity_type
      WHEN 'project'           THEN v := p_entity_id;
      WHEN 'sow'               THEN SELECT project_id INTO v FROM public.sow_documents     WHERE id = p_entity_id;
      WHEN 'change_order'      THEN SELECT project_id INTO v FROM public.change_orders     WHERE id = p_entity_id;
      WHEN 'guardian_flag'     THEN SELECT project_id INTO v FROM public.guardian_flags    WHERE id = p_entity_id;
      WHEN 'guardian_check'    THEN SELECT project_id INTO v FROM public.guardian_checks   WHERE id = p_entity_id;
      WHEN 'exception'         THEN SELECT project_id INTO v FROM public.exceptions_log    WHERE id = p_entity_id;
      WHEN 'invoice'           THEN SELECT project_id INTO v FROM public.invoices          WHERE id = p_entity_id;
      WHEN 'project_message'   THEN SELECT project_id INTO v FROM public.project_messages  WHERE id = p_entity_id;
      WHEN 'payment_milestone' THEN SELECT project_id INTO v FROM public.payment_milestones WHERE id = p_entity_id;
      ELSE v := NULL;
    END CASE;
  END IF;

  IF v IS NULL AND p_metadata IS NOT NULL THEN
    m := p_metadata ->> 'project_id';
    IF m IS NULL THEN m := p_metadata ->> 'projectId'; END IF;
    IF m ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v := m::uuid;
    END IF;
  END IF;

  RETURN v;
EXCEPTION WHEN OTHERS THEN
  -- A lookup problem must never be the reason an audit row fails to write.
  RETURN NULL;
END;
$$;

-- Backfill BEFORE the immutability trigger exists (it would block the UPDATE).
-- Rows whose entity was hard-deleted before this migration stay NULL — that
-- association is unrecoverable, which is exactly why it is now stored.
UPDATE public.audit_log
   SET project_id = public.audit_resolve_project_id(entity_type, entity_id, metadata)
 WHERE project_id IS NULL;

CREATE OR REPLACE FUNCTION public.audit_log_set_project_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NULL THEN
    NEW.project_id := public.audit_resolve_project_id(NEW.entity_type, NEW.entity_id, NEW.metadata);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_set_project_id ON public.audit_log;
CREATE TRIGGER audit_log_set_project_id
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_set_project_id();

-- Project-filtered, newest-first paging (id is the deterministic tiebreaker
-- for rows that share a created_at, e.g. several events logged in one tx).
CREATE INDEX IF NOT EXISTS audit_log_project
  ON public.audit_log (workspace_id, project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_workspace_created_id
  ON public.audit_log (workspace_id, created_at DESC, id DESC);

-- ── (2) append-only ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_log_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.audit_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
    RETURN NULL; -- TRUNCATE (statement-level)
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_immutable ON public.audit_log;
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_block_mutation();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON public.audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_block_mutation();

-- purge_workspace (020) is the one path that legitimately deletes audit rows.
-- Body is identical to 020 apart from the transaction-local flag around the
-- audit_log delete.
CREATE OR REPLACE FUNCTION public.purge_workspace(p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_project_id uuid;
BEGIN
  FOR v_project_id IN SELECT id FROM public.projects WHERE workspace_id = p_workspace_id LOOP
    PERFORM public.purge_project(v_project_id);
  END LOOP;

  PERFORM set_config('app.audit_purge', 'on', true);
  DELETE FROM public.audit_log WHERE workspace_id = p_workspace_id;
  PERFORM set_config('app.audit_purge', 'off', true);

  DELETE FROM public.clients WHERE workspace_id = p_workspace_id;
  DELETE FROM public.workspaces WHERE id = p_workspace_id;
END;
$$;

-- ── (3) processed_webhook_events → claim table ──────────────────────────
ALTER TABLE public.processed_webhook_events
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'done';
ALTER TABLE public.processed_webhook_events
  DROP CONSTRAINT IF EXISTS processed_webhook_events_status_check;
ALTER TABLE public.processed_webhook_events
  ADD CONSTRAINT processed_webhook_events_status_check CHECK (status IN ('processing', 'done'));
ALTER TABLE public.processed_webhook_events
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz NOT NULL DEFAULT now();

-- Pruning (the payment-overdue cron deletes rows older than 90 days).
CREATE INDEX IF NOT EXISTS processed_webhook_events_processed_at
  ON public.processed_webhook_events (processed_at);

-- ── (4) billing_checkouts: server-side binding of a checkout to a workspace ─
-- The Paystack inline popup takes its `metadata` from the browser, and the
-- webhook used to trust metadata.workspaceId to decide WHICH workspace a
-- payment upgrades. A MANAGE_BILLING user who knew another workspace's UUID
-- could aim their payment at it (overwriting its billing row and disabling
-- its real subscription). api/billing/upgrade now records the checkout
-- here, server-side, and the webhook binds subscription.create to a pending
-- row matching (customer email, plan code) — the browser can no longer pick
-- the workspace. metadata.workspaceId survives only as a tie-break hint
-- among rows that already exist for that email + plan.
CREATE TABLE IF NOT EXISTS public.billing_checkouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  email         text NOT NULL,            -- stored lower-cased
  plan_key      text NOT NULL,
  plan_interval text NOT NULL,
  plan_code     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS billing_checkouts_lookup
  ON public.billing_checkouts (email, plan_code, created_at DESC) WHERE consumed_at IS NULL;
ALTER TABLE public.billing_checkouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_checkouts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.billing_checkouts TO service_role;

-- ── (5) billing.needs_paystack_cancel ───────────────────────────────────
-- Grace enforcement downgrades a non-paying workspace and used to null
-- paystack_subscription_code WITHOUT ever disabling the Paystack
-- subscription, so a later retry (or the customer fixing their card) could
-- charge them for a plan they no longer have, with no pointer left to cancel
-- it. The cron now cancels first; if Paystack can't be reached the code is
-- kept and this flag makes the next run retry.
ALTER TABLE public.billing ADD COLUMN IF NOT EXISTS needs_paystack_cancel boolean NOT NULL DEFAULT false;
