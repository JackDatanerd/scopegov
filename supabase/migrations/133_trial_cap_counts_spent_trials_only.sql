-- ============================================================
-- ScopeGov — Migration 133: the lifetime trial cap counts a trial as SPENT only once it was
-- actually used (onboarded, upgraded off trial, or handed to a new owner)
--
-- FINDING (fresh independent audit, section 4 Onboarding): create_workspace_atomic (048/118)
-- raised TRIAL_ALREADY_USED whenever users.trial_used_at — stamped by the user's FIRST-EVER
-- workspace creation — was more than 24h old, whether or not that trial was ever used. Anyone who
-- abandoned the wizard for a day and then used its own "Discard this workspace" exit (or the
-- Sidebar's "Create new workspace" link) hit a permanent 409 dead end: the discarded workspace was
-- the only one they had, and no new one could ever be created.
--
-- FIX: a new users.trial_spent_at records the moment a trial was genuinely consumed. The cap now
-- needs BOTH trial_used_at (older than the 24h grace) AND trial_spent_at. It is set by a trigger on
-- workspaces, so no route can forget it, when a workspace:
--   * completes onboarding (onboarding_completed_at NULL -> set),
--   * moves off the trial plan (plan_tier trial -> anything else), or
--   * changes creator while still on trial (migration 052's hand-off rule, unchanged in effect).
-- It is stored on the user (not derived from workspace rows) because delete_workspace_atomic's
-- purge hard-deletes workspaces after 30 days; deriving it would let a purge reset the cap.
--
-- Backfill is conservative: every existing user with trial_used_at keeps the cap EXCEPT those who
-- demonstrably never spent a trial — workspace rows exist for them and none completed onboarding
-- or left the trial plan. Those are exactly the people stuck in the dead end today.
-- ============================================================

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS trial_spent_at timestamptz;

UPDATE public.users u
SET trial_spent_at = u.trial_used_at
WHERE u.trial_used_at IS NOT NULL
  AND u.trial_spent_at IS NULL
  AND (
    EXISTS (SELECT 1 FROM public.workspaces w
            WHERE w.created_by = u.id
              AND (w.onboarding_completed_at IS NOT NULL OR w.plan_tier <> 'trial'))
    OR NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.created_by = u.id)
  );

CREATE OR REPLACE FUNCTION public.mark_trial_spent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (OLD.onboarding_completed_at IS NULL AND NEW.onboarding_completed_at IS NOT NULL)
     OR (OLD.plan_tier = 'trial' AND NEW.plan_tier <> 'trial')
     OR (OLD.created_by IS DISTINCT FROM NEW.created_by AND NEW.plan_tier = 'trial') THEN
    UPDATE public.users
    SET trial_spent_at = COALESCE(trial_spent_at, now()),
        trial_used_at  = COALESCE(trial_used_at, now())
    WHERE id = NEW.created_by;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS workspaces_mark_trial_spent ON public.workspaces;
CREATE TRIGGER workspaces_mark_trial_spent
  AFTER UPDATE OF onboarding_completed_at, plan_tier, created_by ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.mark_trial_spent();

REVOKE ALL ON FUNCTION public.mark_trial_spent() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_workspace_atomic(p_workspace_id uuid, p_user_id uuid, p_name text, p_slug text, p_agency_name text, p_industry text, p_currency text, p_timezone text, p_jwt_secret text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  owner_role_id uuid;
  all_permissions jsonb;
  existing_trial_used_at timestamptz;
  existing_trial_spent_at timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'p_user_id must match the calling user';
  END IF;

  -- Lock the user row so two concurrent create calls for the same
  -- never-yet-trialed user can't both read trial_used_at as NULL and
  -- both slip through before either write lands.
  SELECT trial_used_at, trial_spent_at INTO existing_trial_used_at, existing_trial_spent_at
  FROM public.users WHERE id = p_user_id FOR UPDATE;

  IF existing_trial_used_at IS NOT NULL
     AND existing_trial_spent_at IS NOT NULL
     AND existing_trial_used_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'TRIAL_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- FIX (migration 057): VIEW_PORTFOLIO added (26th permission) -- see this file's header.
  all_permissions := '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":true,
    "VIEW_CLIENT_DATA":true,"CREATE_PROJECTS":true,"EDIT_SOW":true,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":true,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":true,
    "GRANT_EXCEPTIONS":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":true,"MANAGE_ROLES":true,
    "MANAGE_BILLING":true,"DELETE_PROJECTS":true,
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
    "GRANT_EXCEPTIONS":false,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":true,
    "APPROVE_DOCUMENTS":false,"VIEW_PORTFOLIO":true
  }'::jsonb, true, p_user_id),
  (p_workspace_id, 'Designer', '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":false,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":false,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":false,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":false,
    "APPROVE_DOCUMENTS":false,"VIEW_PORTFOLIO":false
  }'::jsonb, false, p_user_id),
  (p_workspace_id, 'Project Coordinator', '{
    "VIEW_OWN_PROJECTS":false,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"DELETE_PROJECTS":false,
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
$function$;
