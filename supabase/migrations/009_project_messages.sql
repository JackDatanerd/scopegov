-- ============================================================
-- ScopeGov — Migration 009: Project Discussion
-- Adds: project_messages, project_message_mentions, project_message_reads
--
-- The one collaboration surface the app never actually had: a plain
-- place for the people on a project to talk to each other. flag_comments
-- (007_scope_health.sql) is deliberately narrow — governance rationale
-- scoped to a single flag/exception, gated behind APPROVE_FLAGS /
-- GRANT_EXCEPTIONS. This is the opposite: a general per-project feed,
-- open to anyone who can already see the project, with no permission
-- gate of its own. Two entity-agnostic tables + a read-receipt table,
-- deliberately NOT reusing flag_comments' shape — flag_comments is
-- polymorphic (entity_type/entity_id) because it hangs off two other
-- tables; project_messages hangs off exactly one (projects), so a plain
-- FK is more honest than an unused entity_type column.
-- ============================================================

-- ── PROJECT MESSAGES ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  author_id     uuid NOT NULL REFERENCES public.users(id),
  body          text NOT NULL CHECK (char_length(trim(body)) > 0 AND char_length(body) <= 4000),
  edited_at     timestamptz,
  -- Soft delete, not a hard DELETE — a deleted message can still be
  -- @mentioned/referenced and its row is what audit_log's
  -- entity_id points back to. The API route never returns deleted_at IS
  -- NOT NULL rows to clients; deletion is enforced in the API, same as
  -- every other table in this schema (see closing note below).
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_messages_project
  ON public.project_messages(project_id, created_at);
CREATE INDEX IF NOT EXISTS project_messages_author
  ON public.project_messages(author_id);

-- ── @MENTIONS ─────────────────────────────────────────────────
-- One row per user mentioned in a message. Kept as a join table (rather
-- than a users[] array on project_messages) so "notify everyone
-- mentioned" and "has this user ever been mentioned on this project" are
-- both plain indexed queries, not jsonb/array scans.
CREATE TABLE IF NOT EXISTS public.project_message_mentions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES public.project_messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(message_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_message_mentions_user
  ON public.project_message_mentions(user_id, created_at);

-- ── READ RECEIPTS ────────────────────────────────────────────
-- One row per (project, user): "everything before last_read_at is read".
-- Deliberately not a per-message read flag — that'd be N rows per user
-- per project instead of 1, for a feature (an unread dot on a tab) that
-- only ever needs the high-water mark.
CREATE TABLE IF NOT EXISTS public.project_message_reads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  last_read_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);

-- ── RLS ───────────────────────────────────────────────────────
-- Same pattern as every other table in this schema: enabled, no
-- client-side SELECT/INSERT/UPDATE policies. All access goes through the
-- service role in API routes (app/api/projects/[id]/messages/**), which
-- enforce workspace + project-membership checks in application code —
-- see lib/utils/project-access.ts:canReadProject, the same check the
-- project detail page itself uses to decide whether a user can open the
-- project at all.
ALTER TABLE public.project_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_message_mentions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_message_reads     ENABLE ROW LEVEL SECURITY;

-- ── NOTIFICATION DEFAULTS ────────────────────────────────────
-- Seeded per existing workspace now, mirroring flag_comment_added's
-- backfill in 007_scope_health.sql exactly — including the same gap:
-- this is a one-time backfill for workspaces that exist today, not
-- folded into create_workspace_atomic() (see 004_invoicing.sql for why
-- that function is deliberately left alone unless a migration's whole
-- purpose is touching it). A brand-new workspace won't have a
-- workspace_notification_defaults row for 'project_message_mention'
-- until a future migration backfills it — harmless today, since (like
-- flag_comment_added) this row isn't actually read yet: the mention
-- notification in app/api/projects/[id]/messages/route.ts only checks
-- the per-user notification_preferences override, treating a missing
-- preference row as "notify" (only suppresses on an explicit false).
INSERT INTO public.workspace_notification_defaults (workspace_id, event_type, email_enabled, in_app_enabled, locked)
SELECT id, 'project_message_mention', false, true, false
FROM public.workspaces
ON CONFLICT (workspace_id, event_type) DO NOTHING;
