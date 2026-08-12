-- ============================================================
-- ScopeGov — Migration 010: Security Audit Fixes (round 1)
-- Two findings from the pre-launch adversarial audit:
--
--  (A) 12 tables were created without ENABLE ROW LEVEL SECURITY.
--      Every other table in the schema either has RLS + explicit
--      policies (users/workspace_members/workspaces) or RLS with
--      NO policies at all — deny-all to anon/authenticated, so
--      access is only possible through the service-role client in
--      API routes, which does its own workspace_id scoping. These
--      12 tables never got the ALTER TABLE ... ENABLE ROW LEVEL
--      SECURITY line, so on a default Supabase project (anon/
--      authenticated get table grants by default at the schema
--      level) they were fully readable/writable via PostgREST by
--      any authenticated — and in some cases any anon — request,
--      with zero workspace scoping. Worst two: `billing` (payment
--      data) and `revoked_tokens` (deleting your own row here
--      would un-revoke a portal link a workspace owner explicitly
--      killed). Confirmed via grep that no client code anywhere
--      talks to these tables directly — everything already goes
--      through the service-role client — so enabling deny-all RLS
--      here is a pure lockdown with no app-code changes needed.
--
--  (B) create_workspace_atomic() and assign_document_number() are
--      SECURITY DEFINER functions with no EXECUTE grant restriction
--      anywhere in the schema. Postgres grants EXECUTE to PUBLIC by
--      default on function creation, and PUBLIC includes anon/
--      authenticated — so both were callable directly via
--      supabase.rpc(...) from any authenticated browser session,
--      completely bypassing the app's own route handlers.
--      create_workspace_atomic in particular takes p_user_id as a
--      bare parameter with no auth.uid() check, and unconditionally
--      does `UPDATE users SET active_workspace_id = p_workspace_id
--      WHERE id = p_user_id` — so any authenticated user could
--      reassign an arbitrary OTHER user's active workspace to one
--      the attacker just created, and simultaneously add that user
--      as an active "Owner" member of it. Locking down EXECUTE to
--      service_role only closes the direct-RPC path; the auth.uid()
--      guard inside the function is defense-in-depth for the day
--      someone adds a legitimate service_role-adjacent caller.
-- ============================================================

-- ── (A) ENABLE RLS, DENY ALL TO anon/authenticated ─────────────
-- Same pattern as clients/projects/sow_documents/etc: RLS ON, no
-- policies. All access continues through the service-role client
-- in API routes, which already does workspace_id scoping.
ALTER TABLE public.billing                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_contacts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.co_attachments                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_edit_locks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exceptions_log                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revoked_tokens                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scope_adjustments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sow_attachments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sow_templates                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_defaults            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_notification_defaults ENABLE ROW LEVEL SECURITY;

-- Belt-and-braces: explicitly strip any table-level grants PUBLIC/anon/
-- authenticated may have picked up from Supabase's default schema
-- privileges, on these 12 plus every other table that relies on the
-- "RLS enabled, zero policies" deny-all pattern. RLS alone is enough
-- once enabled, but revoking the grant too means a future migration
-- that accidentally adds a permissive policy still can't leak data
-- through a table grant nobody meant to hand out.
REVOKE ALL ON
  public.billing,
  public.client_contacts,
  public.co_attachments,
  public.document_edit_locks,
  public.exceptions_log,
  public.notification_preferences,
  public.revoked_tokens,
  public.scope_adjustments,
  public.sow_attachments,
  public.sow_templates,
  public.workspace_defaults,
  public.workspace_notification_defaults,
  public.roles,
  public.clients,
  public.projects,
  public.project_members,
  public.sow_documents,
  public.change_orders,
  public.amendments,
  public.guardian_flags,
  public.guardian_checks,
  public.project_scope_snapshot,
  public.notifications,
  public.audit_log,
  public.payment_milestones,
  public.workspace_document_sequences,
  public.invoices,
  public.invoice_payments,
  public.contract_reconciliation_snapshots,
  public.scope_health_snapshots,
  public.flag_comments,
  public.flag_attachments,
  public.approval_workflows,
  public.approval_workflow_steps,
  public.approval_requests,
  public.approval_steps,
  public.project_messages,
  public.project_message_mentions,
  public.project_message_reads
FROM PUBLIC, anon, authenticated;

-- service_role bypasses RLS entirely regardless of grants, but give it
-- the explicit grant back for clarity / in case that ever changes.
GRANT ALL ON
  public.billing,
  public.client_contacts,
  public.co_attachments,
  public.document_edit_locks,
  public.exceptions_log,
  public.notification_preferences,
  public.revoked_tokens,
  public.scope_adjustments,
  public.sow_attachments,
  public.sow_templates,
  public.workspace_defaults,
  public.workspace_notification_defaults,
  public.roles,
  public.clients,
  public.projects,
  public.project_members,
  public.sow_documents,
  public.change_orders,
  public.amendments,
  public.guardian_flags,
  public.guardian_checks,
  public.project_scope_snapshot,
  public.notifications,
  public.audit_log,
  public.payment_milestones,
  public.workspace_document_sequences,
  public.invoices,
  public.invoice_payments,
  public.contract_reconciliation_snapshots,
  public.scope_health_snapshots,
  public.flag_comments,
  public.flag_attachments,
  public.approval_workflows,
  public.approval_workflow_steps,
  public.approval_requests,
  public.approval_steps,
  public.project_messages,
  public.project_message_mentions,
  public.project_message_reads
TO service_role;

-- ── (B) LOCK DOWN SECURITY DEFINER RPCs ─────────────────────────
REVOKE ALL ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.assign_document_number(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_document_number(uuid, text)
  TO service_role;

-- Defense-in-depth inside create_workspace_atomic itself: even with the
-- grant locked to service_role, make the function refuse to touch a
-- user row other than the one performing the action, for the day a
-- future caller other than the app's own /api/workspace/create route
-- invokes this with attacker-influenced input. auth.uid() is NULL for
-- service_role calls (no JWT on that connection), so this only
-- constrains callers that DO carry a user JWT — service_role itself
-- is unaffected either way since the grant restricts it to service_role
-- already.
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
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'p_user_id must match the calling user';
  END IF;

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

-- Re-apply the lockdown after CREATE OR REPLACE above — REPLACE preserves
-- existing grants in Postgres, so this is technically redundant, but
-- explicit here so this migration is correct even if run against a
-- fresh database where the function didn't exist with prior grants yet.
REVOKE ALL ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) TO service_role;
