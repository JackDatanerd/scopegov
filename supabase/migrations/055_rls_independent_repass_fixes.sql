-- ============================================================
-- ScopeGov — Migration 055: RLS+permissions independent re-pass fixes
--
-- Three findings from a from-scratch Postgres 16 replay of every prior
-- migration (bootstrapped with Supabase's real anon/authenticated/
-- service_role roles and default privileges, then queried AS those
-- roles) — not just read as SQL, actually run and queried against.
--
-- (A) "workspaces_member" (001) has been completely broken for
--     `authenticated` since migration 041 — CONFIRMED empirically:
--
--       USING (id IN (SELECT workspace_id FROM workspace_members
--                     WHERE user_id = auth.uid() AND status = 'active'))
--
--     This is a cross-table check: evaluating it requires the QUERYING
--     ROLE to have SELECT on workspace_members, because a plain (non-
--     SECURITY DEFINER) policy expression runs with the caller's own
--     privileges, not the policy owner's. Migration 041 — reasoning
--     entirely correctly about workspace_members in isolation ("nothing
--     legitimately reads it directly, revoke everything") — did
--     `REVOKE ALL ON workspace_members FROM ... authenticated`, without
--     noticing the second-order effect on this OTHER table's policy.
--
--     Reproduced directly: replaying only through migration 040,
--     `SELECT agency_name FROM workspaces` as `authenticated` (own
--     workspace, a column on 032/041's own "safe" allow-list) returns
--     the row. Replaying through 041, the identical query fails with
--     `permission denied for table workspace_members` — a table the
--     query doesn't even mention. True for EVERY column, including
--     every one 032/041 fought to preserve read access to — their
--     entire allow-list has been unusable dead code since 041 for
--     anyone but service_role.
--
--     Not exploitable (fails CLOSED, not open) and not hit by any
--     current app code (every real read of `workspaces` already goes
--     through service_role — confirmed by 032/041's own grep sweep) —
--     but it silently defeats the stated purpose of two prior
--     migrations. Fix: the standard Supabase-recommended pattern for
--     this exact shape of policy — move the cross-table check into a
--     SECURITY DEFINER function, so it evaluates with the function
--     owner's privileges rather than the caller's. workspace_members'
--     own lockdown is untouched; nothing grants authenticated direct
--     access to it, only this one narrow boolean function can see
--     inside it on authenticated's behalf.
--
-- (B) Migration 035 added workspaces.guardian_sensitivity_tier and
--     explicitly granted authenticated SELECT on it. Migration 041,
--     written after 035, rebuilt the whole column allow-list from
--     scratch via REVOKE ALL + GRANT SELECT (<explicit list>) — but
--     copied 032's older list rather than 035's updated one, silently
--     dropping this column back off. Confirmed against
--     information_schema.column_privileges: authenticated holds SELECT
--     on the sibling proactive_risk_threshold but not on this column.
--     Restoring it here.
--
-- (C) leave_workspace_atomic (027/034/038) locks every active
--     workspace_members row for the workspace (FOR UPDATE) before
--     checking whether the leaver is the sole holder of MANAGE_ROLES or
--     MANAGE_WORKSPACE_SETTINGS, specifically so two concurrent leaves
--     can't each evaluate the guard against the same stale snapshot.
--     The equivalent guard for editing permissions in place — PATCH
--     /api/team/roles/[id] and PATCH /api/team/[id]
--     (protectedPermissionsOrphanedBy, lib/utils/admin-floor.ts) —
--     reaches the exact same "zero active holders left" end state, but
--     is plain sequential Next.js queries: SELECT active members,
--     simulate the change in JS, conditionally UPDATE, with no lock and
--     no transaction tying the read to the write. Two concurrent
--     MANAGE_ROLES-holder requests (two co-admins, or one admin's slow
--     connection firing a duplicate submit) can each read a pre-change
--     snapshot showing the other still holds it, both pass, both write —
--     orphaning the workspace, the identical failure mode 034 exists to
--     prevent.
--
--     Fix: two atomic RPCs, same FOR UPDATE lock shape as
--     leave_workspace_atomic, checking BOTH protected permissions (kept
--     as a VALUES list mirroring admin-floor.ts's PROTECTED_PERMISSIONS
--     rather than hardcoding just MANAGE_ROLES, so the two can't drift
--     apart the way the JS-only version already once did). The route
--     keeps its existing JS pre-check for a fast, friendly error before
--     ever hitting the database; this RPC is what actually has to be
--     atomic with the write, since the JS pre-check alone is exactly
--     the TOCTOU gap being closed.
-- ============================================================

-- ── (A) workspaces_member: stop depending on the caller's own grant on
--        a different table ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_active_workspace_member(p_workspace_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active'
  )
$$;

-- Grantable to anon too (harmless — auth.uid() is null for anon, so this
-- always returns false rather than erroring), but never anything beyond
-- EXECUTE on this one narrow function.
REVOKE ALL ON FUNCTION public.is_active_workspace_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_workspace_member(uuid, uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "workspaces_member" ON public.workspaces;
CREATE POLICY "workspaces_member" ON public.workspaces
  FOR SELECT USING (public.is_active_workspace_member(id, auth.uid()));

-- ── (B) restore the dropped guardian_sensitivity_tier grant ─────────────
GRANT SELECT (guardian_sensitivity_tier) ON public.workspaces TO authenticated;

-- ── (C) atomic permission-floor RPCs ────────────────────────────────────

-- Used by PATCH /api/team/roles/[id] when `permissions` is being edited.
-- Ceiling/floor checks against the ACTOR (permissionsBeyondCeiling /
-- permissionsBeyondActorForTarget) and the fast JS pre-check both stay in
-- the route exactly as they are — this function only owns the one check
-- that has to be atomic with the write.
CREATE OR REPLACE FUNCTION public.update_role_permissions_atomic(
  p_workspace_id uuid,
  p_role_id      uuid,
  p_permissions  jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_orphaned text[];
BEGIN
  -- Same lock shape as leave_workspace_atomic (027/034/038): block any
  -- concurrent call for the SAME workspace — whether it's this function,
  -- update_member_permissions_atomic below, or leave_workspace_atomic
  -- itself — until this transaction commits or rolls back.
  PERFORM 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active'
    FOR UPDATE;

  -- Mirrors mergePermissions() + protectedPermissionsOrphanedBy()
  -- (lib/utils/admin-floor.ts) in SQL: for every active member, their
  -- post-change effective_permissions is (new role permissions merged
  -- with their own overrides) if they hold this role, otherwise
  -- unchanged. jsonb `||` is a shallow merge with the right-hand side
  -- winning per-key — same "overrides win" semantics as
  -- compute_effective_permissions(). Kept as a VALUES list rather than
  -- hardcoding a single key, matching admin-floor.ts's
  -- PROTECTED_PERMISSIONS, so the two can't independently drift the way
  -- the JS-only version once did (see that file's own history).
  SELECT array_agg(protected.perm) INTO v_orphaned
  FROM (VALUES ('MANAGE_ROLES'), ('MANAGE_WORKSPACE_SETTINGS')) AS protected(perm)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active'
      AND (
        (CASE WHEN wm.role_id = p_role_id
              THEN COALESCE(p_permissions, '{}'::jsonb) || COALESCE(wm.permission_overrides, '{}'::jsonb)
              ELSE wm.effective_permissions
         END) ->> protected.perm
      )::boolean IS TRUE
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

-- Used by PATCH /api/team/[id] when `roleId` and/or `permissionOverrides`
-- is being edited. p_set_role_id / p_set_overrides distinguish "not
-- touching this field" from "setting it to null/empty" — the route's own
-- `body.roleId !== undefined` / `body.permissionOverrides !== undefined`
-- checks, passed through explicitly rather than overloading NULL.
CREATE OR REPLACE FUNCTION public.update_member_permissions_atomic(
  p_workspace_id  uuid,
  p_member_id     uuid,
  p_set_role_id   boolean,
  p_new_role_id   uuid,
  p_set_overrides boolean,
  p_new_overrides jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_current_role_id   uuid;
  v_current_overrides jsonb;
  v_role_permissions  jsonb;
  v_final_overrides   jsonb;
  v_simulated         jsonb;
  v_orphaned          text[];
BEGIN
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
    SELECT permissions INTO v_role_permissions FROM public.roles WHERE id = v_current_role_id;
  ELSE
    v_role_permissions := '{}'::jsonb;
  END IF;

  v_final_overrides := CASE WHEN p_set_overrides THEN p_new_overrides ELSE v_current_overrides END;
  v_simulated := COALESCE(v_role_permissions, '{}'::jsonb) || COALESCE(v_final_overrides, '{}'::jsonb);

  SELECT array_agg(protected.perm) INTO v_orphaned
  FROM (VALUES ('MANAGE_ROLES'), ('MANAGE_WORKSPACE_SETTINGS')) AS protected(perm)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = p_workspace_id AND wm.status = 'active'
      AND (
        (CASE WHEN wm.id = p_member_id THEN v_simulated ELSE wm.effective_permissions END) ->> protected.perm
      )::boolean IS TRUE
  );

  IF v_orphaned IS NOT NULL AND array_length(v_orphaned, 1) > 0 THEN
    RAISE EXCEPTION 'would_orphan_permissions:%', array_to_string(v_orphaned, ',');
  END IF;

  -- Single UPDATE (rather than one per field) so
  -- trg_member_effective_permissions fires once with both final values,
  -- not twice with an intermediate state in between.
  UPDATE public.workspace_members
  SET role_id              = CASE WHEN p_set_role_id   THEN p_new_role_id   ELSE role_id END,
      permission_overrides = CASE WHEN p_set_overrides THEN p_new_overrides ELSE permission_overrides END
  WHERE id = p_member_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_member_permissions_atomic(uuid, uuid, boolean, uuid, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_member_permissions_atomic(uuid, uuid, boolean, uuid, boolean, jsonb) TO service_role;
