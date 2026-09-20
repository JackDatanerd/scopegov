-- ============================================================
-- ScopeGov — Migration 064
-- Auth + MFA and RLS + permissions: independent-audit fix round.
--
-- Idempotent: every statement is CREATE OR REPLACE / IF NOT EXISTS / guarded
-- by a catalog check, so re-running it is safe. Run AFTER 063.
--
-- 1. middleware_gate_state()  — one SECURITY DEFINER RPC that replaces the five
--    session-bound `workspace_members` queries middleware.ts made. Migration 041
--    revoked ALL on workspace_members from `authenticated` on the stated basis
--    that no session-bound code path reads it; middleware.ts did (the grep
--    missed `(supabase as any)` followed by a line break and `.from(`). With
--    041 applied those reads failed with "permission denied", `member` was
--    always null, every onboarded user was bounced to /onboarding (which sends
--    them straight back to /dashboard — an endless redirect), and the
--    forced-MFA-enrolment check silently failed OPEN. 041's lockdown is left
--    fully intact; the middleware now asks this one narrow function instead.
--
-- 2. Permission-map integrity (HIGH). roles.permissions and
--    workspace_members.permission_overrides accepted any JSON, and four layers
--    read it with four different truthiness rules, so {"DELETE_PROJECTS": 1}
--    slipped under the delegation ceiling but was granted by getSession().
--      - is_valid_permission_map() + CHECK constraints: only {key: boolean}
--      - merge_permission_maps(): the single merge used by both triggers,
--        which now coerces to strict booleans even if bad data ever arrives
--      - both triggers + both *_atomic functions re-created with a pinned
--        search_path and `-> perm = 'true'` instead of `->> perm)::boolean`
--        (whose cast accepts '1'/'yes' as true and raises on 'maybe')
--      - existing bad rows are normalised to `false` (deny) first
--
-- 3. auth_attempts — a small failure ledger so /mfa/verify, /mfa/recover and
--    the current-password check in /change-password can be throttled and their
--    failures audited (previously only GoTrue's own IP limits applied).
--
-- 4. Password changes are audited BY THE DATABASE. A trigger on
--    auth.users.encrypted_password writes security.password_changed (and an
--    in-app notification) whichever path changed it — the settings route, the
--    reset flow, or a direct supabase.auth.updateUser() from the browser
--    console, which bypassed every check in /api/auth/change-password. This
--    replaces the app-written row (which the unauthenticated-to-proof
--    /api/auth/password-changed endpoint let any session forge).
--
-- 5. (Account erasure is handled in app code — lib/utils/account-erasure.ts bans the
--    auth user at deletion and anonymises the auth record at day 30 — so this
--    migration adds nothing for it. Its interplay with the triggers below is
--    intentional: both triggers ignore a soft-deleted user.)
--
-- 6. Terms acceptance record (users.terms_accepted_at / terms_version), set by
--    handle_new_user() from signup metadata, and users.email kept in sync when
--    the GoTrue email changes.
--
-- 7. Privilege tidy on public.users: `authenticated` no longer holds INSERT /
--    TRUNCATE / REFERENCES / TRIGGER (only SELECT + UPDATE(name, updated_at)
--    are used); the now-inert users_insert_own policy is dropped.
-- ============================================================


-- ── 2a. Permission-map helpers ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_valid_permission_map(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  -- CASE (not AND): SQL doesn't guarantee AND evaluation order, and jsonb_each()
  -- raises on a non-object.
  SELECT CASE
    WHEN p IS NOT NULL AND jsonb_typeof(p) = 'object'
      THEN NOT EXISTS (SELECT 1 FROM jsonb_each(p) AS e WHERE jsonb_typeof(e.value) <> 'boolean')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.merge_permission_maps(role_perms jsonb, overrides jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    jsonb_object_agg(e.key, (jsonb_typeof(e.value) = 'boolean' AND e.value = 'true'::jsonb)),
    '{}'::jsonb
  )
  FROM jsonb_each(
    (CASE WHEN jsonb_typeof(role_perms) = 'object' THEN role_perms ELSE '{}'::jsonb END)
    || (CASE WHEN jsonb_typeof(overrides) = 'object' THEN overrides ELSE '{}'::jsonb END)
  ) AS e;
$$;

REVOKE ALL ON FUNCTION public.is_valid_permission_map(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_permission_maps(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_valid_permission_map(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_permission_maps(jsonb, jsonb) TO service_role;


-- ── 2b. Triggers: same behaviour as migration 026 (workspace-scoped role
--        lookup), but strict-boolean merge and a pinned search_path ─────────
CREATE OR REPLACE FUNCTION compute_effective_permissions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  role_perms jsonb := '{}';
BEGIN
  IF NEW.role_id IS NOT NULL THEN
    SELECT permissions INTO role_perms FROM public.roles
      WHERE id = NEW.role_id AND workspace_id = NEW.workspace_id;
  END IF;
  NEW.effective_permissions := public.merge_permission_maps(COALESCE(role_perms, '{}'), NEW.permission_overrides);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION propagate_role_permissions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member_row RECORD;
BEGIN
  FOR member_row IN
    SELECT id, permission_overrides
    FROM public.workspace_members
    WHERE role_id = NEW.id AND workspace_id = NEW.workspace_id
  LOOP
    UPDATE public.workspace_members
    SET effective_permissions = public.merge_permission_maps(NEW.permissions, member_row.permission_overrides)
    WHERE id = member_row.id;
  END LOOP;
  RETURN NEW;
END;
$$;


-- ── 2c. Normalise existing bad data (non-boolean → false = deny), then lock the
--        shape in with CHECK constraints ────────────────────────────────────
UPDATE public.roles r
SET permissions = COALESCE((
      SELECT jsonb_object_agg(e.key, (jsonb_typeof(e.value) = 'boolean' AND e.value = 'true'::jsonb))
      FROM jsonb_each(CASE WHEN jsonb_typeof(r.permissions) = 'object' THEN r.permissions ELSE '{}'::jsonb END) AS e
    ), '{}'::jsonb)
WHERE NOT public.is_valid_permission_map(r.permissions);

UPDATE public.workspace_members m
SET permission_overrides = COALESCE((
      SELECT jsonb_object_agg(e.key, (jsonb_typeof(e.value) = 'boolean' AND e.value = 'true'::jsonb))
      FROM jsonb_each(CASE WHEN jsonb_typeof(m.permission_overrides) = 'object' THEN m.permission_overrides ELSE '{}'::jsonb END) AS e
    ), '{}'::jsonb)
WHERE m.permission_overrides IS NOT NULL
  AND NOT public.is_valid_permission_map(m.permission_overrides);

-- Recompute effective_permissions anywhere it still holds a non-boolean value.
-- (`UPDATE OF permission_overrides` fires trg_member_effective_permissions even
-- when the value doesn't change.)
UPDATE public.workspace_members
SET permission_overrides = permission_overrides
WHERE NOT public.is_valid_permission_map(effective_permissions);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_permissions_boolean_map') THEN
    ALTER TABLE public.roles
      ADD CONSTRAINT roles_permissions_boolean_map
      CHECK (public.is_valid_permission_map(permissions)) NOT VALID;
    ALTER TABLE public.roles VALIDATE CONSTRAINT roles_permissions_boolean_map;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_overrides_boolean_map') THEN
    ALTER TABLE public.workspace_members
      ADD CONSTRAINT workspace_members_overrides_boolean_map
      CHECK (permission_overrides IS NULL OR public.is_valid_permission_map(permission_overrides)) NOT VALID;
    ALTER TABLE public.workspace_members VALIDATE CONSTRAINT workspace_members_overrides_boolean_map;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_effective_boolean_map') THEN
    ALTER TABLE public.workspace_members
      ADD CONSTRAINT workspace_members_effective_boolean_map
      CHECK (public.is_valid_permission_map(effective_permissions)) NOT VALID;
    ALTER TABLE public.workspace_members VALIDATE CONSTRAINT workspace_members_effective_boolean_map;
  END IF;
END $$;


-- ── 2d. Orphan-guard functions (from 055) with a strict boolean test ─────────
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
  FROM (VALUES ('MANAGE_ROLES'), ('MANAGE_WORKSPACE_SETTINGS')) AS protected(perm)
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
  FROM (VALUES ('MANAGE_ROLES'), ('MANAGE_WORKSPACE_SETTINGS')) AS protected(perm)
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


-- ── 4/6. New columns ───────────────────────────────────────────────────────
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS terms_version     text;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  clean_name    text;
  v_terms_ver   text;
BEGIN
  clean_name := NULLIF(
    TRIM(
      regexp_replace(
        regexp_replace(COALESCE(NEW.raw_user_meta_data->>'name', ''), '[\r\n\x00-\x1F\x7F]', ' ', 'g'),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );

  -- Terms acceptance (migration 064): the signup form passes the version it
  -- displayed as user metadata. The TIMESTAMP is always server time (never a
  -- client-supplied value), and the version must look like a version label.
  v_terms_ver := NULLIF(LEFT(COALESCE(NEW.raw_user_meta_data->>'terms_version', ''), 32), '');
  IF v_terms_ver IS NOT NULL AND v_terms_ver !~ '^[0-9A-Za-z._-]+$' THEN
    v_terms_ver := NULL;
  END IF;

  INSERT INTO public.users (id, email, name, email_verified_at, terms_accepted_at, terms_version)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(LEFT(clean_name, 120), split_part(NEW.email, '@', 1)),
    CASE WHEN NEW.email_confirmed_at IS NOT NULL THEN NEW.email_confirmed_at ELSE NULL END,
    CASE WHEN v_terms_ver IS NOT NULL THEN now() ELSE NULL END,
    v_terms_ver
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        name  = CASE WHEN public.users.name = '' THEN EXCLUDED.name ELSE public.users.name END,
        email_verified_at = COALESCE(public.users.email_verified_at, EXCLUDED.email_verified_at);
  RETURN NEW;
END;
$$;

-- Keep public.users.email in step with a GoTrue email change (there was no
-- UPDATE trigger, so it silently diverged; getSession() prefers the public
-- copy). Never touches an anonymised / deleted row.
CREATE OR REPLACE FUNCTION public.sync_public_user_email()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.email IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email THEN
    BEGIN
      UPDATE public.users SET email = NEW.email, updated_at = now()
      WHERE id = NEW.id AND deleted_at IS NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'sync_public_user_email failed for %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.sync_public_user_email();


-- ── 4. Path-independent password-change audit ─────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_auth_password_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ws    uuid;
  v_email text;
  v_name  text;
  v_first boolean;
BEGIN
  BEGIN
    SELECT u.email, u.name INTO v_email, v_name FROM public.users u WHERE u.id = NEW.id AND u.deleted_at IS NULL;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    -- Same attribution rule as lib/auth/session.ts resolveActiveWorkspaceId():
    -- the user's active workspace if they still have an active membership in
    -- it, otherwise their oldest active membership.
    SELECT m.workspace_id INTO v_ws
    FROM public.users u
    JOIN public.workspace_members m ON m.user_id = u.id AND m.workspace_id = u.active_workspace_id AND m.status = 'active'
    JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
    WHERE u.id = NEW.id;
    IF v_ws IS NULL THEN
      SELECT m.workspace_id INTO v_ws
      FROM public.workspace_members m
      JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
      WHERE m.user_id = NEW.id AND m.status = 'active'
      ORDER BY m.created_at ASC LIMIT 1;
    END IF;

    IF v_ws IS NOT NULL THEN
      v_first := (OLD.encrypted_password IS NULL OR OLD.encrypted_password = '');
      INSERT INTO public.audit_log (workspace_id, actor_id, actor_email, actor_name, event_type, entity_type, entity_id, entity_name, metadata)
      VALUES (v_ws, NEW.id, COALESCE(v_email, NEW.email, ''), COALESCE(v_name, v_email, NEW.email, ''),
              'security.password_changed', 'user', NEW.id, v_name,
              jsonb_build_object('source', 'db_trigger', 'first_password', v_first));

      -- One row per active membership (mirrors lib/utils/notify.ts notifySecurityEvent):
      -- a password change concerns the person, not one workspace.
      INSERT INTO public.notifications (workspace_id, recipient_id, type, title, body)
      SELECT m.workspace_id, NEW.id, 'security', 'Your password was changed',
             'If this wasn''t you, sign out everywhere from Settings and reset your password immediately.'
      FROM public.workspace_members m
      JOIN public.workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
      WHERE m.user_id = NEW.id AND m.status = 'active';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never let an audit problem block a password change.
    RAISE WARNING 'audit_auth_password_change failed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_password_changed ON auth.users;
CREATE TRIGGER on_auth_user_password_changed
  AFTER UPDATE OF encrypted_password ON auth.users
  FOR EACH ROW WHEN (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password)
  EXECUTE FUNCTION public.audit_auth_password_change();

REVOKE ALL ON FUNCTION public.audit_auth_password_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_public_user_email() FROM PUBLIC, anon, authenticated;


-- ── 3. Failure ledger for auth throttling ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_attempts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('mfa_verify', 'mfa_recover', 'password_verify')),
  succeeded  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_attempts_lookup ON public.auth_attempts (user_id, kind, created_at DESC);
ALTER TABLE public.auth_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.auth_attempts TO service_role;


-- ── 1. middleware gate state ───────────────────────────────────────────────
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

  -- Same resolution as getSession(): the active workspace when the user still
  -- has an active membership in a live workspace, else the oldest such one.
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
    ORDER BY m.created_at ASC LIMIT 1;
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


-- ── 7. Privilege tidy on public.users ──────────────────────────────────────
DROP POLICY IF EXISTS users_insert_own ON public.users;
REVOKE INSERT, TRUNCATE, REFERENCES, TRIGGER ON public.users FROM PUBLIC, anon, authenticated;
