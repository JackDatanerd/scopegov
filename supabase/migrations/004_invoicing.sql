-- ============================================================
-- ScopeGov — Phase 4a: Client Invoicing
-- Agencies invoicing THEIR clients for signed SOWs / accepted
-- COs. Distinct from `billing` (ScopeGov's own Paystack
-- subscription charge to the agency — untouched by this).
-- ScopeGov generates + sends the invoice document and tracks
-- payment status; it never processes the payment itself.
-- ============================================================

-- ── INVOICES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  project_id          uuid NOT NULL REFERENCES public.projects(id),
  milestone_id        uuid REFERENCES public.payment_milestones(id),
  sow_id              uuid REFERENCES public.sow_documents(id),
  co_id               uuid REFERENCES public.change_orders(id),
  invoice_number      text,                       -- assigned by Phase 0's assign_document_number() at send
  title               text NOT NULL,              -- short line shown to the client, e.g. "Milestone 2 — Design phase"
  amount              decimal NOT NULL CHECK (amount > 0),
  amount_paid         decimal NOT NULL DEFAULT 0,  -- denormalized running total from invoice_payments
  currency            text NOT NULL DEFAULT 'USD',
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','sent','partially_paid','paid','overdue','void')),
  due_date            date,
  payment_instructions text,                       -- agency-entered: bank details, "per contract terms", etc.
  notes               text,                        -- internal note, not shown to client
  token               text UNIQUE,                 -- unauthenticated portal-view JWT, same pattern as sow/co
  expires_at          timestamptz,
  sent_at             timestamptz,
  paid_at             timestamptz,
  voided_at           timestamptz,
  void_reason         text,
  created_by          uuid NOT NULL REFERENCES public.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Must bill against exactly one of a milestone, an SOW, or a CO — an
  -- invoice floating free with no linked document/milestone has nothing
  -- for reconciliation (Phase 4) to reconcile against.
  CONSTRAINT invoices_has_source CHECK (
    milestone_id IS NOT NULL OR sow_id IS NOT NULL OR co_id IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS invoices_project ON public.invoices(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_workspace_status ON public.invoices(workspace_id, status);
CREATE INDEX IF NOT EXISTS invoices_milestone ON public.invoices(milestone_id) WHERE milestone_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_document_number
  ON public.invoices(workspace_id, invoice_number) WHERE invoice_number IS NOT NULL;

-- ── INVOICE PAYMENTS ─────────────────────────────────────────
-- Every row here is a MANUAL entry — an agency user logging money they
-- received outside ScopeGov (wire, Stripe invoice they sent separately,
-- check, cash). There is no webhook source; recorded_by is always set.
CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  amount         decimal NOT NULL CHECK (amount > 0),
  paid_at        date NOT NULL,
  method         text NOT NULL DEFAULT 'other'
                 CHECK (method IN ('bank_transfer','stripe','check','cash','other')),
  reference_note text,               -- e.g. a wire confirmation number
  recorded_by    uuid NOT NULL REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_payments_invoice ON public.invoice_payments(invoice_id, paid_at DESC);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;
-- No client-facing policy — same pattern as payment_milestones/change_orders:
-- every read/write goes through the service-role client in API routes,
-- which enforces workspace scoping and permissions in application code.

-- Client portal (unauthenticated, token-based) reuses the sow/co JWT flow —
-- widen the token_type check so invoice tokens can be revoked the same way
-- withdrawn/superseded SOW and CO tokens already are.
ALTER TABLE public.revoked_tokens DROP CONSTRAINT IF EXISTS revoked_tokens_token_type_check;
ALTER TABLE public.revoked_tokens ADD CONSTRAINT revoked_tokens_token_type_check
  CHECK (token_type IN ('sow','co','invoice'));

-- ── amount_paid / status sync trigger ───────────────────────────
-- Keeps invoices.amount_paid and invoices.status correct any time a
-- payment row is inserted, updated, or deleted (e.g. a mis-entered
-- payment gets corrected) — not just on the happy-path insert. Doing
-- this in a trigger (rather than only in the API route) means the
-- running balance can never drift out of sync with invoice_payments,
-- which is the actual source of truth reconciliation reads from.
CREATE OR REPLACE FUNCTION public.recalc_invoice_paid_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invoice_id uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_total_paid decimal;
  v_amount     decimal;
  v_status     text;
  v_due_date   date;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.invoice_payments WHERE invoice_id = v_invoice_id;

  SELECT amount, status, due_date INTO v_amount, v_status, v_due_date
  FROM public.invoices WHERE id = v_invoice_id;

  -- Never touch draft/void invoices' status from this trigger — a draft
  -- shouldn't flip to partially_paid just because someone logged a
  -- payment against it before it was ever sent, and void is terminal.
  IF v_status NOT IN ('draft','void') THEN
    IF v_total_paid >= v_amount THEN
      v_status := 'paid';
    ELSIF v_total_paid > 0 THEN
      v_status := 'partially_paid';
    ELSIF v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN
      v_status := 'overdue';
    ELSE
      v_status := 'sent';
    END IF;
  END IF;

  UPDATE public.invoices SET
    amount_paid = v_total_paid,
    status      = v_status,
    paid_at     = CASE WHEN v_status = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END,
    updated_at  = now()
  WHERE id = v_invoice_id;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER trg_invoice_payments_recalc
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.recalc_invoice_paid_status();

-- ── payment_milestones sync ─────────────────────────────────────
-- On invoice send → milestone.status = 'invoiced'. On invoice reaching
-- paid → milestone.status = 'paid'. This mirrors the existing
-- pending/invoiced/paid/overdue vocabulary payment_milestones already
-- had (with no document behind it until now).
CREATE OR REPLACE FUNCTION public.sync_milestone_from_invoice()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.milestone_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'sent' AND (OLD IS NULL OR OLD.status IS DISTINCT FROM 'sent') THEN
    UPDATE public.payment_milestones
      SET status = 'invoiced', invoiced_at = now()
      WHERE id = NEW.milestone_id AND status IN ('pending','overdue');
  ELSIF NEW.status = 'paid' AND (OLD IS NULL OR OLD.status IS DISTINCT FROM 'paid') THEN
    UPDATE public.payment_milestones
      SET status = 'paid', paid_at = now()
      WHERE id = NEW.milestone_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_invoice_sync_milestone
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.sync_milestone_from_invoice();

-- ── PERMISSION: SEND_INVOICES ────────────────────────────────
-- New workspaces: bake it into create_workspace_atomic()'s Owner /
-- Account Manager / Designer / Project Coordinator preset roles,
-- mirroring SEND_SOW's authority level for each (Owner + Account
-- Manager can send invoices; Designer + Project Coordinator cannot).
CREATE OR REPLACE FUNCTION public.create_workspace_atomic(
  p_workspace_id  uuid,
  p_user_id       uuid,
  p_name          text,
  p_slug          text,
  p_agency_name   text,
  p_industry      text,
  p_currency      text,
  p_timezone      text,
  p_jwt_secret    text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  owner_role_id uuid;
  all_permissions jsonb;
BEGIN
  all_permissions := '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":true,
    "VIEW_CLIENT_DATA":true,"CREATE_PROJECTS":true,"EDIT_SOW":true,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":true,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":true,
    "GRANT_EXCEPTIONS":true,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":true,"MANAGE_ROLES":true,
    "MANAGE_BILLING":true,"EXPORT_DATA":true,"DELETE_PROJECTS":true,
    "VIEW_AUDIT_LOG":true,"MANAGE_WORKSPACE_SETTINGS":true,"SEND_INVOICES":true
  }'::jsonb;

  INSERT INTO public.workspaces (
    id, name, slug, jwt_secret, agency_name, industry, currency, timezone,
    plan_tier, trial_ends_at, created_by
  ) VALUES (
    p_workspace_id, p_name, p_slug, p_jwt_secret, p_agency_name, p_industry,
    p_currency, p_timezone, 'trial', now() + interval '14 days', p_user_id
  );

  INSERT INTO public.roles (id, workspace_id, name, permissions, is_default, created_by)
  VALUES (gen_random_uuid(), p_workspace_id, 'Owner', all_permissions, false, p_user_id)
  RETURNING id INTO owner_role_id;

  INSERT INTO public.roles (workspace_id, name, permissions, is_default, created_by) VALUES
  (p_workspace_id, 'Account Manager', '{
    "VIEW_OWN_PROJECTS":false,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":true,
    "VIEW_CLIENT_DATA":true,"CREATE_PROJECTS":true,"EDIT_SOW":true,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":true,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":true,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":true
  }'::jsonb, true, p_user_id),
  (p_workspace_id, 'Designer', '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":false,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":false,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":false,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":false
  }'::jsonb, false, p_user_id),
  (p_workspace_id, 'Project Coordinator', '{
    "VIEW_OWN_PROJECTS":false,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":false
  }'::jsonb, false, p_user_id);

  INSERT INTO public.workspace_members (
    workspace_id, user_id, role_id, effective_permissions,
    status, joined_at, invited_by
  ) VALUES (
    p_workspace_id, p_user_id, owner_role_id, all_permissions,
    'active', now(), NULL
  );

  UPDATE public.users SET active_workspace_id = p_workspace_id WHERE id = p_user_id;
END;
$$;

-- Existing workspaces created before this migration: their roles' jsonb
-- has no SEND_INVOICES key at all, which hasPermission() treats as false
-- for everyone — including the workspace Owner. Backfill it onto every
-- existing role, mirroring that role's existing SEND_SOW value (same
-- rationale as the preset roles above: whoever could already send
-- contracts to a client is a reasonable default for who can invoice them).
UPDATE public.roles
SET permissions = jsonb_set(permissions, '{SEND_INVOICES}', COALESCE(permissions->'SEND_SOW', 'false'::jsonb)),
    updated_at  = now()
WHERE NOT (permissions ? 'SEND_INVOICES');

-- Propagate to effective_permissions the same way trigger B does for a
-- normal permissions update (this migration bypasses the trigger since
-- it's a bulk UPDATE, not a single-row change through the app).
UPDATE public.workspace_members m
SET effective_permissions = jsonb_set(
  m.effective_permissions, '{SEND_INVOICES}',
  COALESCE(m.permission_overrides->'SEND_INVOICES', r.permissions->'SEND_INVOICES', 'false'::jsonb)
)
FROM public.roles r
WHERE m.role_id = r.id AND NOT (m.effective_permissions ? 'SEND_INVOICES');

-- ── Notification defaults for new event types ────────────────
-- Seeded per existing workspace so the "no row = undefined behavior"
-- gap noted in the spec doesn't apply to invoice events retroactively.
INSERT INTO public.workspace_notification_defaults (workspace_id, event_type, email_enabled, in_app_enabled, locked)
SELECT w.id, e.event_type, true, true, false
FROM public.workspaces w
CROSS JOIN (VALUES ('invoice_sent'), ('invoice_payment_received'), ('invoice_overdue')) AS e(event_type)
ON CONFLICT (workspace_id, event_type) DO NOTHING;
