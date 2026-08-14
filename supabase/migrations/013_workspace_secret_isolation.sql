-- ============================================================
-- ScopeGov — Migration 013: Isolate workspaces.jwt_secret
--
-- FINDING (re-audit, CRITICAL): workspaces.jwt_secret signs every
-- portal JWT — SOW signing links, CO accept/decline/counter links,
-- invoice payment links (see lib/documents/send-sow.ts,
-- lib/documents/send-co.ts, and every app/api/portal/**/route.ts).
-- The column carried a comment ("never in API responses — BUG-062")
-- acknowledging it's sensitive, and every app-code read of it
-- correctly goes through the service-role client. But that only
-- covers ScopeGov's own Next.js routes — it does nothing about
-- Supabase's own PostgREST REST API, which is reachable directly
-- from the browser with the public anon key + any logged-in user's
-- own session, entirely bypassing the Next.js app.
--
-- The "workspaces_member" RLS policy (001_initial_schema.sql) is
-- row-level only:
--   FOR SELECT USING (id IN (SELECT workspace_id FROM
--     workspace_members WHERE user_id = auth.uid() AND status = 'active'))
-- RLS policies gate ROWS, not COLUMNS. workspaces was correctly left
-- out of migration 010's blanket REVOKE ALL (it needs some columns
-- readable by members), so `authenticated` keeps Supabase's default
-- table-level grant — meaning any ACTIVE member of a workspace,
-- regardless of their in-app permission level (RLS only checks
-- `status = 'active'`, not any permission — even the zero-permission
-- default "Designer" role qualifies), can call:
--
--   GET /rest/v1/workspaces?select=jwt_secret&id=eq.<own-workspace-id>
--   apikey: <public anon key>
--   Authorization: Bearer <their own session JWT>
--
-- and read the raw signing secret straight out of the database. With
-- it, they can forge arbitrary portal JWTs for their own workspace —
-- a fake client-signed SOW, a fake accepted change order, a fake
-- paid-invoice confirmation — since the portal routes only verify
-- signature + expiry, trusting whatever claims are embedded. That's
-- a complete break of the client non-repudiation guarantee this
-- product exists to provide.
--
-- FIX: same treatment as billing/revoked_tokens/exceptions_log/etc.
-- in migration 010 — move the secret to its own table, RLS enabled,
-- zero policies (deny-all to anon/authenticated), reachable only via
-- the service-role client. Column-level exposure on a shared table
-- is exactly the class of gap that pattern is designed to prevent;
-- jwt_secret should never have shared a table with member-readable
-- columns in the first place.
-- ============================================================

-- ── New table: one secret per workspace, service-role only ──────
CREATE TABLE IF NOT EXISTS public.workspace_secrets (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  jwt_secret   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.workspace_secrets ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies — RLS enabled with zero policies is
-- deny-all for every role except the table owner and service_role
-- (BYPASSRLS). Matches every other secret/service-role-only table.
REVOKE ALL ON public.workspace_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.workspace_secrets TO service_role;

-- ── Backfill existing workspaces ─────────────────────────────────
INSERT INTO public.workspace_secrets (workspace_id, jwt_secret)
SELECT id, jwt_secret FROM public.workspaces
ON CONFLICT (workspace_id) DO NOTHING;

-- ── Repoint create_workspace_atomic() at the new table ───────────
-- Same signature as the 010 version (still the current one — 011/012
-- don't touch it) so this REPLACEs it in place; no caller changes
-- needed in app/api/workspace/create/route.ts.
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

  -- jwt_secret no longer written here — see workspace_secrets insert below.
  INSERT INTO public.workspaces (
    id, name, slug, agency_name, industry, currency, timezone,
    plan_tier, trial_ends_at, created_by
  ) VALUES (
    p_workspace_id, p_name, p_slug, p_agency_name, p_industry,
    p_currency, p_timezone, 'trial', now() + interval '14 days', p_user_id
  );

  INSERT INTO public.workspace_secrets (workspace_id, jwt_secret)
  VALUES (p_workspace_id, p_jwt_secret);

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

REVOKE ALL ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) TO service_role;

-- ── Drop the now-redundant column ────────────────────────────────
-- Backfill above guarantees every existing workspace has a matching
-- workspace_secrets row before this runs.
ALTER TABLE public.workspaces DROP COLUMN IF EXISTS jwt_secret;
