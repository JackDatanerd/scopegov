-- ============================================================
-- ScopeGov — Migration 026: RLS + permissions deep audit fixes
--
-- Found via a from-scratch Postgres 16 replay of all 25 migrations in
-- Supabase's actual bootstrap order (baseline anon/authenticated default
-- privileges applied before any project migration runs), then verified
-- empirically with has_function_privilege()/has_column_privilege() and
-- real cross-tenant query attempts — not just read from the SQL.
--
-- (A) CRITICAL: purge_project(uuid) and purge_workspace(uuid) (migration
--     020) are SECURITY DEFINER functions that permanently cascade-delete
--     a project or an entire workspace, with NO auth.uid()/membership
--     check inside the function body at all — unlike every sibling RPC
--     in this schema (create_workspace_atomic, assign_document_number),
--     which are both correctly REVOKE ALL ... GRANT EXECUTE TO
--     service_role. These two were never given that treatment, so
--     Postgres' default (EXECUTE granted to PUBLIC on function creation)
--     was still in effect. Empirically confirmed via
--     has_function_privilege('authenticated', ..., 'EXECUTE') = true for
--     both. Concretely: any logged-in user (any workspace, any
--     permission level, or none) could call
--     supabase.rpc('purge_workspace', { p_workspace_id: '<any-uuid>' })
--     directly from the browser and permanently wipe ANY OTHER tenant's
--     entire workspace — projects, contracts, invoices, audit trail,
--     everything — completely bypassing the app, RLS, and every
--     permission check. Only the two legitimate callers (the
--     project-purge and workspace-purge crons, both already using
--     service_role) are affected by locking this down.
--
-- (B) CRITICAL: processed_webhook_events (migration 022) never got
--     ENABLE ROW LEVEL SECURITY, and — unlike its ~40 sibling tables
--     that rely on the same "RLS enabled, zero policies" deny-all
--     pattern — was never given the belt-and-braces REVOKE ALL either.
--     Empirically confirmed both anon and authenticated had full
--     SELECT/INSERT/UPDATE/DELETE on it. It carries no workspace_id at
--     all, so this wasn't even same-tenant-scoped: anyone with the
--     public anon key could pre-insert a row with a guessed/predicted
--     Paystack idempotency_key to silently suppress a real upcoming
--     webhook (e.g. hiding a failed payment from ever being flagged),
--     or truncate/delete the table to force a webhook-reprocessing
--     storm. Fixed with the exact same pattern every sibling table
--     already uses.
--
-- (C) Defense-in-depth: compute_effective_permissions() and
--     propagate_role_permissions() (migration 001) look up a role's
--     permissions by id with no check that the role belongs to the
--     SAME workspace as the member being computed. Empirically
--     reproduced: pointing a Workspace-1 member's role_id at Workspace
--     2's Owner role silently granted them full cross-tenant
--     effective_permissions. Every known app-layer call site
--     (team/[id], team/invite, team/roles — see their own "audit round
--     4" comments) already validates role_id against session.workspaceId
--     before writing it, so this is not currently reachable through the
--     app — but the database itself provided zero backstop against a
--     future write path, a direct RPC (if one is ever added), or a bug
--     in a later migration. Adding the check here, matching this
--     schema's own established belt-and-braces philosophy (e.g. the
--     REVOKE-then-explicit-GRANT-back pattern already used everywhere
--     else). A cross-workspace role_id now composes to zero permissions
--     (treated the same as no role at all) instead of silently
--     inheriting the wrong workspace's role.
-- ============================================================

-- ── (A) Lock down the two unrestricted purge RPCs ──────────────────────
REVOKE ALL ON FUNCTION public.purge_project(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_project(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.purge_workspace(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_workspace(uuid) TO service_role;

-- ── (B) Lock down processed_webhook_events, matching every sibling ─────
ALTER TABLE public.processed_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.processed_webhook_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.processed_webhook_events TO service_role;

-- ── (C) Workspace-scope the role lookup in both permission triggers ────
CREATE OR REPLACE FUNCTION compute_effective_permissions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  role_perms jsonb := '{}';
  overrides  jsonb := '{}';
  merged     jsonb := '{}';
  key        text;
BEGIN
  -- FIX (migration 026): was `WHERE id = NEW.role_id` with no
  -- workspace_id check — a role_id from a different workspace would
  -- silently compose that workspace's permissions into this member's
  -- effective_permissions. A cross-workspace role_id now resolves to no
  -- permissions at all, same as role_id being NULL.
  IF NEW.role_id IS NOT NULL THEN
    SELECT permissions INTO role_perms FROM public.roles
      WHERE id = NEW.role_id AND workspace_id = NEW.workspace_id;
  END IF;
  overrides := COALESCE(NEW.permission_overrides, '{}');
  merged := COALESCE(role_perms, '{}');
  FOR key IN SELECT jsonb_object_keys(overrides) LOOP
    merged := jsonb_set(merged, ARRAY[key], overrides->key);
  END LOOP;
  NEW.effective_permissions := merged;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION propagate_role_permissions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  member_row RECORD;
  overrides  jsonb;
  merged     jsonb := '{}';
  key        text;
BEGIN
  -- FIX (migration 026): this already only ever iterates members whose
  -- role_id = NEW.id, so it was never itself reachable cross-workspace —
  -- but a role_id can only genuinely match NEW.id for members in the
  -- SAME workspace once (C) above prevents the cross-workspace write in
  -- the first place. Added the explicit workspace_id filter anyway so
  -- this function doesn't depend on that invariant holding elsewhere;
  -- it's a no-op today and a backstop if that ever changes.
  FOR member_row IN
    SELECT id, permission_overrides
    FROM public.workspace_members
    WHERE role_id = NEW.id AND workspace_id = NEW.workspace_id
  LOOP
    overrides := COALESCE(member_row.permission_overrides, '{}');
    merged := NEW.permissions;
    FOR key IN SELECT jsonb_object_keys(overrides) LOOP
      merged := jsonb_set(merged, ARRAY[key], overrides->key);
    END LOOP;
    UPDATE public.workspace_members
    SET effective_permissions = merged
    WHERE id = member_row.id;
  END LOOP;
  RETURN NEW;
END;
$$;
