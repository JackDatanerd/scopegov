-- ============================================================
-- ScopeGov — Migration 057
--
-- VIEW_PORTFOLIO — a dedicated permission for the Portfolio dashboard.
--
-- WHY (Portfolio deep audit): the public site promises the Portfolio is
-- "gated on its own permission, separate from day-to-day project
-- access". In reality the page, /api/reports/portfolio, its export and
-- the sidebar item were all gated on VIEW_ALL_PROJECTS — there was no
-- permission of its own, so nobody could be given the workspace-wide risk
-- rollup without also being given every project (and vice versa).
--
-- BACKFILL: every role / member that can see the portfolio today
-- (VIEW_ALL_PROJECTS) is granted VIEW_PORTFOLIO, so nobody loses access
-- when the app-side gate moves. Least privilege can then be applied from
-- Team -> Roles. NEW workspaces seed it for Owner and Account Manager only
-- (Project Coordinator / Designer do not get the workspace-wide rollup by
-- default).
--
-- create_workspace_atomic is replaced in full (same body as 054 — the
-- all_permissions literal lives inside the function, so it cannot be
-- ALTERed) with VIEW_PORTFOLIO as the 26th permission. Skipping that step
-- would reproduce the APPROVE_DOCUMENTS seeding bug documented in 054:
-- brand-new workspaces would have no holder of the permission at all.
-- ============================================================

UPDATE public.roles
SET permissions = jsonb_set(
      permissions,
      '{VIEW_PORTFOLIO}',
      COALESCE(permissions->'VIEW_ALL_PROJECTS', 'false'::jsonb)
    ),
    updated_at = now()
WHERE NOT (permissions ? 'VIEW_PORTFOLIO');

-- The roles UPDATE above fires trg_role_permissions_propagate, which recomputes
-- effective_permissions for every member holding a role (role permissions +
-- their own overrides). What it can NOT cover is a member who reaches
-- VIEW_ALL_PROJECTS through a per-member OVERRIDE (or has no role): their role
-- says VIEW_PORTFOLIO=false, so they would silently lose the portfolio. Give
-- exactly those members an explicit override — writing permission_overrides
-- fires trg_member_effective_permissions, which recomputes effective_permissions
-- and keeps the grant through every future recompute.
UPDATE public.workspace_members
SET permission_overrides = jsonb_set(COALESCE(permission_overrides, '{}'::jsonb), '{VIEW_PORTFOLIO}', 'true'::jsonb)
WHERE COALESCE(effective_permissions->>'VIEW_ALL_PROJECTS', 'false') = 'true'
  AND COALESCE(effective_permissions->>'VIEW_PORTFOLIO', 'false') <> 'true';

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

  -- FIX (migration 057): VIEW_PORTFOLIO added (26th permission) -- see this file's header.
  all_permissions := '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":true,
    "VIEW_CLIENT_DATA":true,"CREATE_PROJECTS":true,"EDIT_SOW":true,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":true,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":true,
    "GRANT_EXCEPTIONS":true,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":true,"MANAGE_ROLES":true,
    "MANAGE_BILLING":true,"EXPORT_DATA":true,"DELETE_PROJECTS":true,
    "VIEW_AUDIT_LOG":true,"MANAGE_WORKSPACE_SETTINGS":true,"SEND_INVOICES":true,
    "APPROVE_DOCUMENTS":true,"VIEW_PORTFOLIO":true
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
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":true,
    "APPROVE_DOCUMENTS":false,"VIEW_PORTFOLIO":true
  }'::jsonb, true, p_user_id),
  (p_workspace_id, 'Designer', '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":false,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":false,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":false,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":false,
    "APPROVE_DOCUMENTS":false,"VIEW_PORTFOLIO":false
  }'::jsonb, false, p_user_id),
  (p_workspace_id, 'Project Coordinator', '{
    "VIEW_OWN_PROJECTS":false,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":false,
    "APPROVE_DOCUMENTS":false,"VIEW_PORTFOLIO":false
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
