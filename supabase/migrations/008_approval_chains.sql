-- ============================================================
-- ScopeGov — Migration 003: Approval Chains (Phase 3)
-- Gates SOW / CO `send` actions behind a configurable, multi-step
-- approval sequence before they reach the client.
--
-- Design notes (see PR description / build notes for full rationale):
--   • document_type is free text, not an enum — 'sow' and 'co' today,
--     'invoice' later (Phase 4a) without a migration, matching the
--     scope doc's explicit instruction on approval_workflows.
--   • Workflow → step config lives in two tables (approval_workflows /
--     approval_workflow_steps) rather than jsonb, mirroring the existing
--     relational style used throughout 001_initial_schema.sql (e.g.
--     project_members, sow_attachments) and giving the config real FK
--     integrity against roles/users instead of untyped blobs.
--   • Runtime state (approval_requests / approval_steps) is a separate
--     pair of tables from the config tables, deliberately symmetric with
--     them — one row per step per request, so partial progress through a
--     multi-step chain is queryable directly rather than reconstructed
--     from a status enum + counter.
--   • threshold_amount is nullable and workflows are matched by "closest
--     threshold at or below the document's value" — this supports tiered
--     rules (e.g. "COs over $10k need 2 sign-offs, everything else needs
--     none") without extra schema, per the scope doc's forward-looking
--     note about invoice-approval thresholds.
--   • RLS is enabled with no client-facing policies, consistent with
--     every other table in 001_initial_schema.sql — all access in this
--     codebase goes through the service-role client with permission
--     checks enforced in the API layer (lib/auth/session.ts).
-- ============================================================

-- ── APPROVAL WORKFLOWS (config) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.approval_workflows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  document_type     text NOT NULL,              -- 'sow' | 'co' | (future) 'invoice'
  name              text NOT NULL,               -- agency-facing label, e.g. "COs over $10k"
  threshold_amount  numeric,                     -- NULL = applies to every document of this type
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid NOT NULL REFERENCES public.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_workflows_lookup
  ON public.approval_workflows(workspace_id, document_type, is_active);

-- ── APPROVAL WORKFLOW STEPS (config) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.approval_workflow_steps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id       uuid NOT NULL REFERENCES public.approval_workflows(id) ON DELETE CASCADE,
  step_order        int NOT NULL,
  approver_role_id  uuid REFERENCES public.roles(id) ON DELETE CASCADE,
  approver_user_id  uuid REFERENCES public.users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Exactly one of role/user must be set per step.
  CONSTRAINT approval_workflow_steps_one_approver CHECK (
    (approver_role_id IS NOT NULL AND approver_user_id IS NULL) OR
    (approver_role_id IS NULL AND approver_user_id IS NOT NULL)
  ),
  UNIQUE(workflow_id, step_order)
);

-- ── APPROVAL REQUESTS (runtime) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.approval_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  workflow_id    uuid NOT NULL REFERENCES public.approval_workflows(id),
  document_type  text NOT NULL,
  document_id    uuid NOT NULL,
  -- Denormalized for cheap workspace/project-scoped queries without a
  -- join through whichever document table document_type points at.
  project_id     uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  requested_by   uuid NOT NULL REFERENCES public.users(id),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','cancelled')),
  current_step   int NOT NULL DEFAULT 1,
  total_steps    int NOT NULL,
  -- Snapshot of title/amount/currency at request time, so the queue and
  -- audit trail still read correctly even if the underlying document
  -- changes (or is a newer version) before the request is decided.
  context        jsonb NOT NULL DEFAULT '{}',
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_requests_workspace_status
  ON public.approval_requests(workspace_id, status);
CREATE INDEX IF NOT EXISTS approval_requests_project
  ON public.approval_requests(project_id);
-- A document can only have one *pending* approval request in flight at a
-- time — prevents duplicate chains from a double-click or race on send.
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_one_pending_per_doc
  ON public.approval_requests(document_type, document_id) WHERE status = 'pending';

-- ── APPROVAL STEPS (runtime) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.approval_steps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  step_order        int NOT NULL,
  approver_role_id  uuid REFERENCES public.roles(id),
  approver_user_id  uuid REFERENCES public.users(id),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','skipped')),
  decided_by        uuid REFERENCES public.users(id),
  decided_at        timestamptz,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id, step_order)
);
CREATE INDEX IF NOT EXISTS approval_steps_request ON public.approval_steps(request_id);
-- Powers "my pending approvals" queries for user-assigned steps.
CREATE INDEX IF NOT EXISTS approval_steps_approver_pending
  ON public.approval_steps(approver_user_id, status) WHERE status = 'pending';
-- Powers "my pending approvals" queries for role-assigned steps.
CREATE INDEX IF NOT EXISTS approval_steps_role_pending
  ON public.approval_steps(approver_role_id, status) WHERE status = 'pending';

-- ── RLS ──────────────────────────────────────────────────────────
-- Service role bypasses RLS entirely (see 001_initial_schema.sql header
-- note); enabling with no policies denies all anon/authenticated access,
-- consistent with every other application table in this schema. All
-- reads/writes go through API routes using the service client with
-- permission checks in lib/auth/session.ts.
ALTER TABLE public.approval_workflows       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_workflow_steps  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_steps           ENABLE ROW LEVEL SECURITY;
