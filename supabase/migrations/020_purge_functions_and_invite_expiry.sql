-- ============================================================
-- ScopeGov — Migration 020: Purge functions + invite expiry state
--
-- Numbered 020 (not 019) because 019 was already taken by
-- 019_section_audit_fixes.sql on the real main branch by the time this
-- landed — this was originally written and tested against an older base
-- commit before that file existed. Renumbered on merge; no content change.
--
-- FIX (cron audit, section 17): project-purge and workspace-purge were
-- hard-DELETEing rows directly against tables where project_id/
-- workspace_id FKs default to (or explicitly set) ON DELETE RESTRICT —
-- e.g. sow_documents.project_id, change_orders.workspace_id,
-- invoices.workspace_id, guardian_flags/guardian_checks.workspace_id,
-- projects.workspace_id itself. Any project/workspace with real content
-- made the DELETE throw a foreign-key-violation, which both cron routes
-- then silently swallowed (they only read `data`, never `error`),
-- reporting `purged: 0` / `ok: true` with nothing actually removed.
--
-- Rather than loosening those RESTRICT constraints — several are clearly
-- deliberate (workspace_id is RESTRICT on nearly every financial/legal
-- table in 001_initial_schema.sql, a sensible guard against an accidental
-- direct DELETE wiping a workspace's contracts) — these two functions
-- perform the explicit, correctly-ordered cascade the RESTRICT
-- constraints are gatekeeping, atomically, inside one transaction. This
-- mirrors the existing create_workspace_atomic() pattern in this schema
-- for the same reason noted there: Supabase JS has no multi-statement
-- transactions, so multi-step, must-succeed-together operations go
-- through a single RPC call.
--
-- Two FK cycles exist and need breaking before delete, not after:
--   change_orders.flag_id <-> guardian_flags.id
--   guardian_flags.check_id <-> guardian_checks.id
-- (added via ALTER TABLE ... ADD CONSTRAINT after both tables existed —
-- see fk_co_flag / fk_flag_check in 001_initial_schema.sql). Both columns
-- are nullable, so nulling them out for the project's rows first, then
-- deleting, avoids the cycle entirely.
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_project(p_project_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- ── 1. Break circular / self-referencing FKs among this project's rows ──
  UPDATE public.change_orders   SET flag_id = NULL, parent_co_id = NULL WHERE project_id = p_project_id;
  UPDATE public.guardian_flags  SET check_id = NULL                     WHERE project_id = p_project_id;
  UPDATE public.guardian_checks SET duplicate_of_id = NULL, matched_amendment_id = NULL, flag_id = NULL
                                                                          WHERE project_id = p_project_id;
  UPDATE public.sow_documents   SET previous_version_id = NULL          WHERE project_id = p_project_id;
  UPDATE public.invoices        SET sow_id = NULL, co_id = NULL, milestone_id = NULL
                                                                          WHERE project_id = p_project_id;

  -- ── 2. Delete leaves before their parents ──
  DELETE FROM public.invoice_payments
    WHERE invoice_id IN (SELECT id FROM public.invoices WHERE project_id = p_project_id);
  DELETE FROM public.invoices WHERE project_id = p_project_id;

  DELETE FROM public.flag_comments    WHERE project_id = p_project_id;
  DELETE FROM public.flag_attachments WHERE project_id = p_project_id;

  DELETE FROM public.exceptions_log        WHERE project_id = p_project_id;
  DELETE FROM public.scope_adjustments     WHERE project_id = p_project_id;
  DELETE FROM public.project_scope_snapshot WHERE project_id = p_project_id;

  DELETE FROM public.guardian_checks WHERE project_id = p_project_id;
  DELETE FROM public.guardian_flags  WHERE project_id = p_project_id;

  DELETE FROM public.amendments WHERE project_id = p_project_id;
  DELETE FROM public.co_attachments
    WHERE co_id IN (SELECT id FROM public.change_orders WHERE project_id = p_project_id);
  DELETE FROM public.change_orders WHERE project_id = p_project_id;

  DELETE FROM public.payment_milestones WHERE project_id = p_project_id;
  DELETE FROM public.sow_attachments
    WHERE sow_id IN (SELECT id FROM public.sow_documents WHERE project_id = p_project_id);
  DELETE FROM public.sow_documents WHERE project_id = p_project_id;

  -- Note: document_edit_locks and revoked_tokens have no FK back to
  -- projects at all (bare document_id/token columns), so neither could
  -- ever block the deletes above — and neither is currently written to
  -- anywhere in the app (both fully scaffolded, unused tables), so there's
  -- nothing to clean up here in practice either.

  -- project_messages (+ mentions/reads), project_members, approval_requests
  -- (+ approval_steps), and contract_reconciliation_snapshots all already
  -- have ON DELETE CASCADE on project_id — removed automatically below.
  DELETE FROM public.projects WHERE id = p_project_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_workspace(p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_project_id uuid;
BEGIN
  FOR v_project_id IN SELECT id FROM public.projects WHERE workspace_id = p_workspace_id LOOP
    PERFORM public.purge_project(v_project_id);
  END LOOP;

  -- audit_log.workspace_id is RESTRICT everywhere else in this app quite
  -- deliberately (nothing should casually wipe an audit trail) — the purge
  -- cron, years after a workspace was deleted, is the one place that's
  -- actually supposed to finish the job.
  DELETE FROM public.audit_log WHERE workspace_id = p_workspace_id;

  -- clients.workspace_id is RESTRICT and projects.client_id has no cascade,
  -- but every project in this workspace is gone by this point (loop above),
  -- so this is now safe. client_contacts cascades from clients(id).
  DELETE FROM public.clients WHERE workspace_id = p_workspace_id;

  -- roles, workspace_members, billing, workspace_secrets, sow_templates,
  -- workspace_defaults, workspace_notification_defaults,
  -- notification_preferences, notifications, workspace_document_sequences,
  -- ai_usage_log, scope_health_snapshots, approval_workflows (+ steps) all
  -- already have ON DELETE CASCADE on workspace_id — removed automatically.
  DELETE FROM public.workspaces WHERE id = p_workspace_id;
END;
$$;

-- ============================================================
-- FIX (cron audit, section 17): invite-cleanup computed a 7-day cutoff
-- (`d7ago`) and never used it — invites sat at status='invited' for the
-- full 30-day grace window even once their token had actually expired at
-- day 7, which (a) showed as "Pending" in the team UI long after the link
-- was dead, and (b) blocked re-inviting the same email for up to 30 extra
-- days, since team/invite/route.ts's pending-invite check only looks at
-- status='invited' with no awareness of expiry. Adding 'expired' as a
-- distinct status lets the cron mark that transition explicitly.
-- ============================================================
ALTER TABLE public.workspace_members DROP CONSTRAINT IF EXISTS workspace_members_status_check;
ALTER TABLE public.workspace_members ADD CONSTRAINT workspace_members_status_check
  CHECK (status IN ('active', 'invited', 'deactivated', 'expired'));
