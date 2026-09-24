-- ScopeGov — Migration 074: propagate the "prefer a completed workspace"
-- fallback fix to middleware_gate_state()
--
-- FIX (Auth+MFA + RLS/permissions joint independent re-pass — HIGH): the
-- "oldest active membership" fallback used whenever a user's
-- active_workspace_id is unset or stale used to just pick the single oldest
-- row, with no regard for whether that workspace's onboarding was ever
-- completed. lib/auth/session.ts's pickFallbackMembership() fixed this
-- app-side (prefer a completed workspace, oldest-first only as a tie-break);
-- migration 065 carried the same fix into leave_workspace_atomic
-- (describing that as "the one remaining call site that lives in SQL"); and
-- migration 068 carried it into audit_active_workspace() and, separately,
-- rewrote audit_auth_password_change() to call security_audit_insert(...,
-- true) — writing to every active workspace instead of picking one, making
-- the fallback question moot for that function specifically.
--
-- middleware_gate_state() (migration 064, predating all three of those
-- fixes) was missed and still carries the original, unfixed shape. Its
-- onboarding_complete flag drives whether middleware sends a signed-in user
-- to /onboarding. Reproduced live: a user who owns an older, never-onboarded
-- workspace and is also an active member of a newer, fully-onboarded one
-- (invited in), with a stale/unset active_workspace_id, gets
-- onboarding_complete: false and is bounced to /onboarding on every request
-- despite having a real, completed workspace.
--
-- (A second site found in the same pass, app/api/auth/callback/route.ts's
-- resolveOnboardingMember(), is TypeScript, not SQL, and is fixed in that
-- file directly by calling the shared pickFallbackMembership() helper. A
-- third candidate, audit_auth_password_change(), turned out to already be
-- correctly fixed by migration 068 as described above — checked here
-- against its actual current definition, not migration 064's superseded
-- one, after that assumption was caught by this repo's own committed
-- tests/pg-replay.test.ts "audited in EVERY workspace" case.)

CREATE OR REPLACE FUNCTION public.middleware_gate_state(p_mfa_permissions text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_deleted boolean;
  v_active  uuid;
  v_onb     timestamptz;
  v_has     boolean := false;
  v_must    boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('deleted', false, 'has_workspace', false,
                              'onboarding_complete', false, 'must_enroll_mfa', false);
  END IF;

  SELECT (u.deleted_at IS NOT NULL), u.active_workspace_id INTO v_deleted, v_active
  FROM public.users u WHERE u.id = v_uid;
  v_deleted := COALESCE(v_deleted, false);

  -- Same resolution as getSession()/pickFallbackMembership(): the active
  -- workspace when the user still has an active membership in a live one,
  -- else the oldest active membership that has completed onboarding, else
  -- (nothing has) the oldest active membership, period.
  IF v_active IS NOT NULL THEN
    SELECT w.onboarding_completed_at INTO v_onb
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = v_uid AND m.workspace_id = v_active
      AND m.status = 'active' AND w.deleted_at IS NULL;
    v_has := FOUND;
  END IF;
  IF NOT v_has THEN
    SELECT w.onboarding_completed_at INTO v_onb
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = v_uid AND m.status = 'active' AND w.deleted_at IS NULL
    ORDER BY (w.onboarding_completed_at IS NULL) ASC, m.created_at ASC LIMIT 1;
    v_has := FOUND;
  END IF;

  -- Strict JSON `true` only, like lib/auth/mfa-policy.ts.
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.user_id = v_uid AND m.status = 'active'
      AND EXISTS (
        SELECT 1 FROM unnest(COALESCE(p_mfa_permissions, '{}'::text[])) AS p(perm)
        WHERE (m.effective_permissions -> p.perm) = 'true'::jsonb
      )
  ) INTO v_must;

  RETURN jsonb_build_object(
    'deleted',             v_deleted,
    'has_workspace',       v_has,
    'onboarding_complete', (v_onb IS NOT NULL),
    'must_enroll_mfa',     v_must
  );
END;
$$;

REVOKE ALL ON FUNCTION public.middleware_gate_state(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.middleware_gate_state(text[]) TO authenticated, service_role;
