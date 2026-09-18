-- ============================================================
-- ScopeGov — Migration 047: lifetime trial-usage cap
--
-- FINDING (deep audit, Workspace lifecycle + Onboarding re-pass,
-- section-by-section): migration 019's one_active_trial_per_creator
-- is a partial unique index scoped to `deleted_at IS NULL` — it only
-- ever blocks having TWO trial workspaces active at the same time. It
-- does nothing to stop a user from discarding a trial workspace (via
-- workspace/delete, including the onboarding wizard's own "discard
-- this workspace" exit panel) and immediately creating a brand new
-- one, resetting the 14-day trial clock indefinitely. The rpcError
-- handling in app/api/workspace/create/route.ts already carries a
-- comment claiming this exact "reset their 14-day trial indefinitely"
-- scenario was closed by 019 — it wasn't; 019 only ever addressed the
-- concurrent case.
--
-- Adds a one-way, one-time-set `trial_used_at` on public.users and
-- enforces it inside create_workspace_atomic (the single choke point
-- every workspace creation already goes through, service-role only —
-- same reasoning migration 042 gives for fixing name-capping at
-- handle_new_user() rather than duplicating logic at each call site).
--
-- A 24-hour grace window from first use is intentionally preserved:
-- the onboarding wizard's own "discard and start over" flow is a
-- legitimate, expected path for someone who fat-fingered step 0 or
-- wants a clean restart minutes after signing up, and this must not
-- punish that. What it closes is a returning user, days or weeks
-- later, farming a second free 14-day trial by discarding an old one.
-- ============================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS trial_used_at timestamptz;

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
  existing_trial_used_at timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'p_user_id must match the calling user';
  END IF;

  -- Lock the user row so two concurrent create calls for the same
  -- never-yet-trialed user can't both read trial_used_at as NULL and
  -- both slip through before either write lands.
  SELECT trial_used_at INTO existing_trial_used_at
  FROM public.users WHERE id = p_user_id FOR UPDATE;

  IF existing_trial_used_at IS NOT NULL
     AND existing_trial_used_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'TRIAL_ALREADY_USED' USING ERRCODE = 'P0001';
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

  UPDATE public.users
  SET active_workspace_id = p_workspace_id,
      trial_used_at = COALESCE(trial_used_at, now())
  WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) TO service_role;
