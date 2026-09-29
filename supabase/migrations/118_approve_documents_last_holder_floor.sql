-- ============================================================
-- Migration 118: never let the last APPROVE_DOCUMENTS holder disappear
-- (RLS + permissions audit)
--
-- The protected-permission floor (071) deliberately excluded
-- APPROVE_DOCUMENTS, because a workspace can legitimately never have granted
-- it. But once someone HOLDS it, the same trap as the other five applies:
-- the permission ceiling means nobody can grant what they don't hold, so a
-- workspace whose last approver leaves can never approve documents again
-- without SQL access.
--
-- Only the Node routes checked this, from a non-atomic snapshot, and three
-- database paths did not check it at all:
--   - leave_workspace_atomic  (also reached by DELETE /api/account/delete)
--   - update_role_permissions_atomic
--   - update_member_permissions_atomic
-- Reproduced on Postgres: the owner strips their own APPROVE_DOCUMENTS, the
-- one remaining holder leaves, and no active member holds it afterwards.
--
-- Rule (all three): block only when a holder exists BEFORE the change and
-- none would exist AFTER. A workspace that never granted it is unaffected.
-- Error shape is the existing 'would_orphan_permissions:PERM'.
--
-- CREATE OR REPLACE keeps the existing owner, SECURITY DEFINER settings and
-- the service_role-only EXECUTE grants.
-- ============================================================

CREATE OR REPLACE FUNCTION public.leave_workspace_atomic(p_workspace_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member_id             uuid;
  v_leaver_settings_admin boolean;
  v_leaver_roles_admin    boolean;
  v_leaver_permissions    jsonb;
  v_active_count          int;
  v_other_settings_admins int;
  v_other_roles_admins    int;
  v_current_active_ws     uuid;
  v_fallback_ws           uuid;
  v_ws_created_by         uuid;
  v_ws_plan_tier          text;
  v_orphaned              text[];
BEGIN
  PERFORM 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active'
    FOR UPDATE;

  SELECT id,
         (effective_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean,
         (effective_permissions->>'MANAGE_ROLES')::boolean,
         effective_permissions
    INTO v_member_id, v_leaver_settings_admin, v_leaver_roles_admin, v_leaver_permissions
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active';

  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'not_a_member';
  END IF;

  SELECT count(*) INTO v_active_count
  FROM public.workspace_members WHERE workspace_id = p_workspace_id AND status = 'active';

  IF v_active_count <= 1 THEN
    RAISE EXCEPTION 'last_member';
  END IF;

  IF COALESCE(v_leaver_settings_admin, false) THEN
    SELECT count(*) INTO v_other_settings_admins
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active' AND id <> v_member_id
      AND (effective_permissions->>'MANAGE_WORKSPACE_SETTINGS')::boolean IS TRUE;
    IF v_other_settings_admins = 0 THEN
      RAISE EXCEPTION 'sole_admin';
    END IF;
  END IF;

  IF COALESCE(v_leaver_roles_admin, false) THEN
    SELECT count(*) INTO v_other_roles_admins
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active' AND id <> v_member_id
      AND (effective_permissions->>'MANAGE_ROLES')::boolean IS TRUE;
    IF v_other_roles_admins = 0 THEN
      RAISE EXCEPTION 'sole_roles_admin';
    END IF;
  END IF;

  -- Restored from migration 071 (silently dropped by 080's rewrite).
  SELECT array_agg(protected.perm) INTO v_orphaned
  FROM (VALUES ('MANAGE_BILLING'), ('INVITE_MEMBERS'), ('VIEW_AUDIT_LOG'), ('APPROVE_DOCUMENTS')) AS protected(perm)
  WHERE (v_leaver_permissions -> protected.perm) = 'true'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active' AND wm.id <> v_member_id
        AND (wm.effective_permissions -> protected.perm) = 'true'::jsonb
    );

  IF v_orphaned IS NOT NULL AND array_length(v_orphaned, 1) > 0 THEN
    RAISE EXCEPTION 'would_orphan_permissions:%', array_to_string(v_orphaned, ',');
  END IF;

  SELECT created_by, plan_tier INTO v_ws_created_by, v_ws_plan_tier
  FROM public.workspaces WHERE id = p_workspace_id;

  IF v_ws_created_by = p_user_id THEN
    IF v_ws_plan_tier = 'trial' THEN
      RAISE EXCEPTION 'trial_creator';
    ELSE
      RAISE EXCEPTION 'owner_must_transfer';
    END IF;
  END IF;

  UPDATE public.workspace_members
  SET status = 'deactivated', deactivated_at = now()
  WHERE id = v_member_id;

  PERFORM public.archive_member_projects(v_member_id);

  DELETE FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND invited_by = p_user_id AND status IN ('invited', 'expired') AND user_id IS DISTINCT FROM p_user_id;

  SELECT active_workspace_id INTO v_current_active_ws FROM public.users WHERE id = p_user_id;
  IF v_current_active_ws = p_workspace_id THEN
    SELECT wm.workspace_id INTO v_fallback_ws
    FROM public.workspace_members wm
    JOIN public.workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = p_user_id AND wm.status = 'active' AND w.deleted_at IS NULL
    ORDER BY (w.onboarding_completed_at IS NULL) ASC, wm.created_at ASC
    LIMIT 1;

    UPDATE public.users SET active_workspace_id = v_fallback_ws WHERE id = p_user_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_role_permissions_atomic(p_workspace_id uuid, p_role_id uuid, p_permissions jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_orphaned text[];
BEGIN
  IF NOT public.is_valid_permission_map(p_permissions) THEN
    RAISE EXCEPTION 'invalid_permissions';
  END IF;

  PERFORM 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active'
    FOR UPDATE;

  SELECT array_agg(protected.perm) INTO v_orphaned
  FROM (VALUES ('MANAGE_ROLES'), ('MANAGE_WORKSPACE_SETTINGS'), ('MANAGE_BILLING'), ('INVITE_MEMBERS'), ('VIEW_AUDIT_LOG')) AS protected(perm)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active'
      AND (
        public.merge_permission_maps(
          CASE WHEN wm.role_id = p_role_id THEN p_permissions ELSE NULL END,
          CASE WHEN wm.role_id = p_role_id THEN wm.permission_overrides ELSE wm.effective_permissions END
        ) -> protected.perm
      ) = 'true'::jsonb
  );

  IF v_orphaned IS NOT NULL AND array_length(v_orphaned, 1) > 0 THEN
    RAISE EXCEPTION 'would_orphan_permissions:%', array_to_string(v_orphaned, ',');
  END IF;

  -- APPROVE_DOCUMENTS is not in the protected list above (a workspace may never
  -- have granted it), but once someone holds it the last holder must not be
  -- removable: nobody can grant it back without already holding it. Checked
  -- under the same all-active-members row lock, so two concurrent edits
  -- cannot both pass.
  IF EXISTS (
       SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active'
         AND (wm.effective_permissions -> 'APPROVE_DOCUMENTS') = 'true'::jsonb)
     AND NOT EXISTS (
       SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active'
         AND (
           public.merge_permission_maps(
             CASE WHEN wm.role_id = p_role_id THEN p_permissions ELSE NULL END,
             CASE WHEN wm.role_id = p_role_id THEN wm.permission_overrides ELSE wm.effective_permissions END
           ) -> 'APPROVE_DOCUMENTS') = 'true'::jsonb)
  THEN
    RAISE EXCEPTION 'would_orphan_permissions:APPROVE_DOCUMENTS';
  END IF;

  UPDATE public.roles
  SET permissions = p_permissions, updated_at = now()
  WHERE id = p_role_id AND workspace_id = p_workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'role_not_found';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_member_permissions_atomic(p_workspace_id uuid, p_member_id uuid, p_set_role_id boolean, p_new_role_id uuid, p_set_overrides boolean, p_new_overrides jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_current_role_id   uuid;
  v_current_overrides jsonb;
  v_role_permissions  jsonb;
  v_final_overrides   jsonb;
  v_simulated         jsonb;
  v_orphaned          text[];
BEGIN
  IF p_set_overrides AND p_new_overrides IS NOT NULL AND NOT public.is_valid_permission_map(p_new_overrides) THEN
    RAISE EXCEPTION 'invalid_permissions';
  END IF;

  PERFORM 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active'
    FOR UPDATE;

  SELECT role_id, permission_overrides INTO v_current_role_id, v_current_overrides
  FROM public.workspace_members
  WHERE id = p_member_id AND workspace_id = p_workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  IF p_set_role_id THEN
    IF p_new_role_id IS NOT NULL THEN
      SELECT permissions INTO v_role_permissions
      FROM public.roles WHERE id = p_new_role_id AND workspace_id = p_workspace_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid_role';
      END IF;
    ELSE
      v_role_permissions := '{}'::jsonb;
    END IF;
  ELSIF v_current_role_id IS NOT NULL THEN
    SELECT permissions INTO v_role_permissions
    FROM public.roles WHERE id = v_current_role_id AND workspace_id = p_workspace_id;
  ELSE
    v_role_permissions := '{}'::jsonb;
  END IF;

  v_final_overrides := CASE WHEN p_set_overrides THEN p_new_overrides ELSE v_current_overrides END;
  v_simulated := public.merge_permission_maps(v_role_permissions, v_final_overrides);

  SELECT array_agg(protected.perm) INTO v_orphaned
  FROM (VALUES ('MANAGE_ROLES'), ('MANAGE_WORKSPACE_SETTINGS'), ('MANAGE_BILLING'), ('INVITE_MEMBERS'), ('VIEW_AUDIT_LOG')) AS protected(perm)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active'
      AND (
        (CASE WHEN wm.id = p_member_id THEN v_simulated ELSE wm.effective_permissions END) -> protected.perm
      ) = 'true'::jsonb
  );

  IF v_orphaned IS NOT NULL AND array_length(v_orphaned, 1) > 0 THEN
    RAISE EXCEPTION 'would_orphan_permissions:%', array_to_string(v_orphaned, ',');
  END IF;

  -- See update_role_permissions_atomic: the last APPROVE_DOCUMENTS holder
  -- cannot be stripped, atomically, under the same row lock.
  IF EXISTS (
       SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active'
         AND (wm.effective_permissions -> 'APPROVE_DOCUMENTS') = 'true'::jsonb)
     AND NOT EXISTS (
       SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active'
         AND ((CASE WHEN wm.id = p_member_id THEN v_simulated ELSE wm.effective_permissions END)
              -> 'APPROVE_DOCUMENTS') = 'true'::jsonb)
  THEN
    RAISE EXCEPTION 'would_orphan_permissions:APPROVE_DOCUMENTS';
  END IF;

  UPDATE public.workspace_members
  SET role_id              = CASE WHEN p_set_role_id   THEN p_new_role_id   ELSE role_id END,
      permission_overrides = CASE WHEN p_set_overrides THEN p_new_overrides ELSE permission_overrides END
  WHERE id = p_member_id;
END;
$function$;

-- New workspaces stop being seeded with the retired keys (current
-- create_workspace_atomic minus MARK_DELIVERABLE_STATUS / MARK_PAYMENT_MILESTONES;
-- nothing else changed).
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

-- Retire two permissions that no route ever enforced (audit finding: the role
-- editor showed them as switches but they gated nothing). Same treatment as
-- EXPORT_DATA in migration 068.
UPDATE public.roles SET permissions = permissions - 'MARK_DELIVERABLE_STATUS' - 'MARK_PAYMENT_MILESTONES'
 WHERE permissions ?| ARRAY['MARK_DELIVERABLE_STATUS','MARK_PAYMENT_MILESTONES'];
UPDATE public.workspace_members SET permission_overrides = permission_overrides - 'MARK_DELIVERABLE_STATUS' - 'MARK_PAYMENT_MILESTONES'
 WHERE permission_overrides ?| ARRAY['MARK_DELIVERABLE_STATUS','MARK_PAYMENT_MILESTONES'];
UPDATE public.workspace_members SET effective_permissions = effective_permissions - 'MARK_DELIVERABLE_STATUS' - 'MARK_PAYMENT_MILESTONES'
 WHERE effective_permissions ?| ARRAY['MARK_DELIVERABLE_STATUS','MARK_PAYMENT_MILESTONES'];

-- ============================================================
-- delete_workspace_atomic (migration 116) referenced invoice_payments.workspace_id,
-- a column that does not exist (payments belong to an invoice, which carries the
-- workspace). plpgsql binds late, so 116 installed fine and then failed with
-- 'column "workspace_id" does not exist' on EVERY call. Same defect, same fix, in
-- the route's own payment guard (app/api/workspace/delete/route.ts).
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_workspace_atomic(p_workspace_id uuid, p_now timestamptz)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted_at timestamptz;
  v_exists boolean;
BEGIN
  SELECT true, deleted_at INTO v_exists, v_deleted_at
  FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;

  IF v_exists IS NOT TRUE THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;
  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_deleted';
  END IF;

  -- Same blockers the route reports one-by-one with friendly messages, re-checked
  -- here under the workspace lock (the route's reads are not atomic with its write).
  IF EXISTS (SELECT 1 FROM public.sow_documents
             WHERE workspace_id = p_workspace_id
               AND status IN ('signed', 'awaiting_signature', 'changes_requested'))
     OR EXISTS (SELECT 1 FROM public.change_orders
                WHERE workspace_id = p_workspace_id
                  AND status IN ('accepted', 'awaiting_response', 'awaiting_countersignature', 'countered', 'stalled'))
     OR EXISTS (SELECT 1 FROM public.invoice_payments ip
                JOIN public.invoices i ON i.id = ip.invoice_id
                WHERE i.workspace_id = p_workspace_id)
     OR EXISTS (SELECT 1 FROM public.invoices
                WHERE workspace_id = p_workspace_id AND status IN ('sent', 'overdue'))
  THEN
    RAISE EXCEPTION 'blocked_by_live_documents';
  END IF;

  UPDATE public.workspaces SET deleted_at = p_now, updated_at = p_now WHERE id = p_workspace_id;

  -- Only genuine members (see migration 112: pending/expired invites are not members
  -- and must never be stamped, or a later restore would turn them into ghosts).
  UPDATE public.workspace_members
  SET status = 'deactivated', deactivated_at = p_now
  WHERE workspace_id = p_workspace_id AND status = 'active';

  -- Move everyone whose active workspace was this one onto their oldest live
  -- workspace, preferring one whose onboarding is finished (mirrors
  -- pickFallbackMembership in lib/auth/session.ts); NULL when they have none.
  UPDATE public.users u
  SET active_workspace_id = (
    SELECT wm.workspace_id
    FROM public.workspace_members wm
    JOIN public.workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = u.id
      AND wm.status = 'active'
      AND w.deleted_at IS NULL
      AND wm.workspace_id <> p_workspace_id
    ORDER BY (w.onboarding_completed_at IS NULL), wm.created_at ASC
    LIMIT 1
  )
  WHERE u.active_workspace_id = p_workspace_id;
END;
$function$;

-- CREATE OR REPLACE keeps each function's existing ACL, but restate it so the
-- final state is explicit (and survives a DROP/CREATE if these are ever rebuilt):
-- service_role only, exactly as before.
REVOKE ALL ON FUNCTION public.leave_workspace_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_role_permissions_atomic(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_member_permissions_atomic(uuid, uuid, boolean, uuid, boolean, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_workspace_atomic(uuid, uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_workspace_atomic(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_workspace_atomic(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_role_permissions_atomic(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_member_permissions_atomic(uuid, uuid, boolean, uuid, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_workspace_atomic(uuid, uuid, text, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_workspace_atomic(uuid, timestamptz) TO service_role;
