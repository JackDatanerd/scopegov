-- ============================================================
-- ScopeGov — Phase 2: Portfolio Scope-Health Dashboard
-- Adds: scope_health_snapshots, flag_comments, flag_attachments
-- Run after 001_initial_schema.sql through 006_mfa_backup_codes.sql.
-- ============================================================

-- ── SCOPE HEALTH SNAPSHOTS ───────────────────────────────────
-- One row per workspace per day. Snapshot table (not a live view) because
-- guardian_flags / exceptions_log are event-level, not time-series — a
-- trend chart needs a point-in-time rollup, not an expensive on-the-fly
-- aggregation across every project on every dashboard load.
CREATE TABLE IF NOT EXISTS public.scope_health_snapshots (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  snapshot_date           date NOT NULL,
  open_flags_count        integer NOT NULL DEFAULT 0,
  open_flags_by_severity  jsonb   NOT NULL DEFAULT '{"high":0,"medium":0,"low":0}',
  exceptions_count        integer NOT NULL DEFAULT 0,
  exceptions_value_total  decimal NOT NULL DEFAULT 0,
  -- decimal, not a fraction of contract value — see cron for weighting formula
  contract_value_at_risk  decimal NOT NULL DEFAULT 0,
  stalled_sow_count       integer NOT NULL DEFAULT 0,
  stalled_co_count        integer NOT NULL DEFAULT 0,
  active_project_count    integer NOT NULL DEFAULT 0,
  -- currency shown alongside contract_value_at_risk — workspaces can run
  -- projects in multiple currencies (see app/api/reports/route.ts); the
  -- rollup picks the most common currency across active projects, same
  -- resolution strategy already used there, and records which one so the
  -- dashboard never silently mixes currencies in one figure.
  currency                text    NOT NULL DEFAULT 'USD',
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS scope_health_snapshots_workspace
  ON public.scope_health_snapshots(workspace_id, snapshot_date DESC);

-- ── FLAG / EXCEPTION COMMENTS (governance-scoped, not general chat) ──
-- Audit rationale for why a flag was resolved or an exception approved.
-- Deliberately narrow: no @mentions, no threading — scoped only to
-- guardian_flags and exceptions_log, per spec addendum.
CREATE TABLE IF NOT EXISTS public.flag_comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id),
  entity_type   text NOT NULL CHECK (entity_type IN ('flag','exception')),
  entity_id     uuid NOT NULL, -- guardian_flags.id or exceptions_log.id, by entity_type
  body          text NOT NULL CHECK (char_length(trim(body)) > 0),
  author_id     uuid NOT NULL REFERENCES public.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flag_comments_entity
  ON public.flag_comments(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS flag_comments_project ON public.flag_comments(project_id);

-- ── FLAG / EXCEPTION ATTACHMENTS ──────────────────────────────
-- Evidence attached to a flag or exception (e.g. the scope-creep email
-- screenshot, a signed addendum justifying an override). Same shape as
-- sow_attachments/co_attachments, scoped to guardian_flags/exceptions_log.
-- Feeds Phase 1's audit export: an auditor asking "why was this exception
-- approved" gets an attached document, not just a log line.
CREATE TABLE IF NOT EXISTS public.flag_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id),
  entity_type   text NOT NULL CHECK (entity_type IN ('flag','exception')),
  entity_id     uuid NOT NULL,
  file_name     text NOT NULL,
  file_size     integer NOT NULL,
  mime_type     text NOT NULL,
  storage_path  text NOT NULL,
  uploaded_by   uuid NOT NULL REFERENCES public.users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flag_attachments_entity
  ON public.flag_attachments(entity_type, entity_id, uploaded_at);
CREATE INDEX IF NOT EXISTS flag_attachments_project ON public.flag_attachments(project_id);

-- ── RLS ───────────────────────────────────────────────────────
-- Same pattern as guardian_flags/exceptions_log/audit_log: enabled, no
-- client-side SELECT/INSERT policies. All access goes through the
-- service role in API routes, which enforce workspace + permission
-- checks in application code (consistent with the rest of the schema —
-- see closing comment in 001_initial_schema.sql).
ALTER TABLE public.scope_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flag_comments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flag_attachments       ENABLE ROW LEVEL SECURITY;

-- ── NOTIFICATION DEFAULTS ────────────────────────────────────
-- Seeded per existing workspace now (not as cleanup later - spec's
-- "Notification Defaults" cross-cutting note), same VALUES-cross-join
-- pattern 004_invoicing.sql already established for invoice_* events.
--
-- Deliberately NOT folded into create_workspace_atomic() this time -
-- that function has already been replaced once (in 004_invoicing.sql,
-- to bake in SEND_INVOICES) since it was first written in
-- 001_initial_schema.sql, and a third blind CREATE OR REPLACE here would
-- risk silently reverting whichever version lands last if two migrations
-- touching it are authored in parallel. The one gap this leaves - a
-- brand-new workspace won't have a workspace_notification_defaults row
-- for 'flag_comment_added' until this backfill catches up in a future
-- migration - is harmless today: like the rest of the notifications
-- system (see notify.ts), workspace_notification_defaults isn't actually
-- read yet - app/api/scope-governance/.../comments/route.ts only checks
-- the per-user notification_preferences override, and treats a missing
-- preference row as "notify" (only suppresses on an explicit false).
INSERT INTO public.workspace_notification_defaults (workspace_id, event_type, email_enabled, in_app_enabled, locked)
SELECT id, 'flag_comment_added', true, true, false
FROM public.workspaces
ON CONFLICT (workspace_id, event_type) DO NOTHING;
