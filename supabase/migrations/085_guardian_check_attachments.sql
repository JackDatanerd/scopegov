-- ============================================================
-- ScopeGov — Migration 085: Guardian check attachments
--
-- FEATURE (independent pass round 2, section 13 — feature gap): Postmark's
-- inbound webhook (app/api/guardian/inbound/route.ts) has always reported
-- each attachment's Name AND its base64 Content, but only the Name was ever
-- kept (guardian_checks.source_metadata.attachments, a bare array of
-- strings) — the actual file was discarded the moment the request finished.
-- Meanwhile api/scope-governance/.../attachments is a full upload/download
-- surface (private bucket, signed URLs, magic-byte validation) for evidence
-- attached BY HAND to a flag or exception. A client emailing a spec doc or a
-- signed addendum straight into the Guardian inbox — plausibly the single
-- most common way real evidence actually arrives — got a filename and
-- nothing behind it, while the identical file dragged in through the UI was
-- fully preserved.
--
-- Same shape as flag_attachments (007_scope_health.sql) / sow_attachments /
-- co_attachments, in the same private `flag-evidence` bucket, but its own
-- table rather than reusing flag_attachments directly: that table's
-- entity_type CHECK is constrained to ('flag','exception') and its
-- uploaded_by is NOT NULL REFERENCES users(id) — both wrong for a
-- system-saved attachment against a guardian_checks row that may never
-- have a human uploader or ever become a flag at all (in_scope /
-- covered_by_co / pending / classification_failed checks never link to
-- one). Loosening a shared, actively-used table's constraints for one new
-- caller is more invasive than a small table of its own.
CREATE TABLE IF NOT EXISTS public.guardian_check_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id),
  check_id      uuid NOT NULL REFERENCES public.guardian_checks(id) ON DELETE CASCADE,
  file_name     text NOT NULL,
  file_size     integer NOT NULL,
  mime_type     text NOT NULL,
  storage_path  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guardian_check_attachments_check
  ON public.guardian_check_attachments(check_id, created_at);
CREATE INDEX IF NOT EXISTS guardian_check_attachments_project
  ON public.guardian_check_attachments(project_id);

-- Same pattern as flag_attachments/flag_comments/scope_health_snapshots:
-- RLS enabled, no client-side policies — all access goes through the
-- service role in API routes, which enforce workspace + permission checks
-- in application code.
ALTER TABLE public.guardian_check_attachments ENABLE ROW LEVEL SECURITY;
