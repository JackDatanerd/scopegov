-- ============================================================
-- ScopeGov — Phase 4: Budget / Contract Reconciliation
-- Time series of contracted vs invoiced vs paid vs at-risk
-- value per project, rolled up by the reconciliation-rollup
-- cron. Depends on Phase 4a (invoices/invoice_payments) for
-- real invoiced/paid figures — before this, `payment_milestones`
-- had status labels with no document behind them.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contract_reconciliation_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  contracted_value  decimal NOT NULL DEFAULT 0,  -- base contract_value + accepted amendments (BUG-053: excludes exceptions_log)
  invoiced_to_date  decimal NOT NULL DEFAULT 0,  -- sum of invoices.amount where status NOT IN (draft, void)
  paid_to_date      decimal NOT NULL DEFAULT 0,  -- sum of invoice_payments.amount — reflects partials correctly
  at_risk_value     decimal NOT NULL DEFAULT 0,  -- total of open/awaiting change orders not yet accepted
  snapshot_date     date NOT NULL DEFAULT CURRENT_DATE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS contract_reconciliation_project
  ON public.contract_reconciliation_snapshots(project_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS contract_reconciliation_workspace
  ON public.contract_reconciliation_snapshots(workspace_id, snapshot_date DESC);

ALTER TABLE public.contract_reconciliation_snapshots ENABLE ROW LEVEL SECURITY;
-- No client-facing policy — read via /api/reports/reconciliation using the
-- service-role client, scoped by workspace_id + VIEW_FINANCIALS in app code,
-- same pattern as every other reporting table in this schema.
