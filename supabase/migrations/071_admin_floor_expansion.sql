-- ScopeGov — Migration 071: expand the admin floor beyond MANAGE_ROLES /
-- MANAGE_WORKSPACE_SETTINGS
--
-- FIX (deep audit, Settings + Team re-pass round 2 — MEDIUM): admin-floor.ts
-- (migration 034's app-layer half) protects exactly two permissions from
-- ever being orphaned workspace-wide, because — its own comment says —
-- with zero holders, "no role edit and no member override can ever put it
-- back," since permissionsBeyondCeiling only lets an actor grant what they
-- already hold. That reasoning is not specific to those two permissions.
-- It applies identically to:
--   - MANAGE_BILLING — zero holders means nobody can ever pay, upgrade,
--     downgrade, or manage the subscription again. The workspace is
--     financially stuck, permanently, the moment its plan needs to change.
--   - INVITE_MEMBERS — zero holders means nobody can grow the team, and
--     nobody can grant INVITE_MEMBERS back to fix that, since granting it
--     requires already holding it.
--   - VIEW_AUDIT_LOG — zero holders means nobody can review the workspace's
--     own audit trail, and (same shape again) nobody can re-grant that
--     ability either.
-- All three are seeded onto every workspace's Owner role at creation
-- (create_workspace_atomic grants the full permission set), so — exactly
-- like MANAGE_ROLES/MANAGE_WORKSPACE_SETTINGS — a real workspace always
-- starts with a holder; the only way to reach zero is a role edit or member
-- override that strips the last one, which is precisely the edit this floor
-- exists to refuse. (APPROVE_DOCUMENTS is deliberately NOT here: migration
-- 054/admin-floor.ts's own comment explains a workspace can legitimately
-- have never granted it to anyone, so protecting it here would make
-- routine role edits fail in that ordinary case — that reasoning does not
-- apply to any of these three.)
--
-- Same orphan-guard functions as migration 064
-- (update_role_permissions_atomic, update_member_permissions_atomic), same
-- technique: the protected-permission list they each check is inlined as a
-- VALUES(...) set, expanded here from two rows to five. leave_workspace_atomic
-- (migration 068) is extended alongside its two existing hardcoded checks
-- (sole_admin / sole_roles_admin, left untouched to avoid disturbing that
-- function's own carefully-commented TOCTOU-race locking and trial-creator
-- logic) with one additional generic check for the three new permissions,
-- raised in the SAME 'would_orphan_permissions:PERM1,PERM2' shape the other
-- two functions already use — the app-layer message it produces
-- (describeProtectedPermission, lib/utils/admin-floor.ts) and the callers
-- that parse it (app/api/team/[id]/route.ts, app/api/team/roles/[id]/route.ts)
-- are unchanged; app/api/workspace/leave/route.ts gains one new branch to
-- handle it the same way.

CREATE OR REPLACE FUNCTION public.update_role_permissions_atomic(
  p_workspace_id uuid,
  p_role_id      uuid,
  p_permissions  jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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

  UPDATE public.roles
  SET permissions = p_permissions, updated_at = now()
  WHERE id = p_role_id AND workspace_id = p_workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'role_not_found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_role_permissions_atomic(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_role_permissions_atomic(uuid, uuid, jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.update_member_permissions_atomic(
  p_workspace_id  uuid,
  p_member_id     uuid,
  p_set_role_id   boolean,
  p_new_role_id   uuid,
  p_set_overrides boolean,
  p_new_overrides jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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

  UPDATE public.workspace_members
  SET role_id              = CASE WHEN p_set_role_id   THEN p_new_role_id   ELSE role_id END,
      permission_overrides = CASE WHEN p_set_overrides THEN p_new_overrides ELSE permission_overrides END
  WHERE id = p_member_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_member_permissions_atomic(uuid, uuid, boolean, uuid, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_member_permissions_atomic(uuid, uuid, boolean, uuid, boolean, jsonb) TO service_role;


-- leave_workspace_atomic: keep the two existing named checks (sole_admin /
-- sole_roles_admin) exactly as they are — they're relied on by name in
-- workspace/leave/route.ts and account/delete/route.ts's per-code message
-- tables, and rewriting them into the generic array form buys nothing but
-- risk. Add one more generic check, after them, for the three newly
-- protected permissions — same shape update_role_permissions_atomic and
-- update_member_permissions_atomic already use above, so the existing
-- would_orphan_permissions parsing on the client side covers it for free.
CREATE OR REPLACE FUNCTION public.leave_workspace_atomic(p_workspace_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  -- FIX (migration 071): MANAGE_BILLING / INVITE_MEMBERS / VIEW_AUDIT_LOG
  -- get the same floor as the two checks above, generically, only checked
  -- (and only capable of blocking) when the leaver actually holds one of
  -- them — same "trivially safe when it doesn't apply" shape as the checks
  -- above, just not duplicated a third and fourth and fifth time by hand.
  SELECT array_agg(protected.perm) INTO v_orphaned
  FROM (VALUES ('MANAGE_BILLING'), ('INVITE_MEMBERS'), ('VIEW_AUDIT_LOG')) AS protected(perm)
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

  IF v_ws_created_by = p_user_id AND v_ws_plan_tier = 'trial' THEN
    RAISE EXCEPTION 'trial_creator';
  END IF;

  UPDATE public.workspace_members
  SET status = 'deactivated', deactivated_at = now()
  WHERE id = v_member_id;

  -- Same as DELETE /api/team/[id]: archive (not delete) the assignments so a later
  -- reactivation can restore them (migration 067).
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
$$;
REVOKE ALL ON FUNCTION public.leave_workspace_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_workspace_atomic(uuid, uuid) TO service_role;
