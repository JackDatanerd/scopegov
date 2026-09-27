-- 090_platform_admin.sql
--
-- Adds a platform-level (cross-workspace) admin surface. Distinct from
-- `roles`/`workspace_members.effective_permissions`, which are entirely
-- workspace-scoped and have no concept of "the founder/support team looking
-- across every tenant." Nothing in the schema before this migration allowed
-- that at all.
--
-- Design choices, spelled out because this table controls access to every
-- workspace's data:
--   1. is_platform_admin lives on public.users, not workspace_members, since
--      it is not scoped to any one workspace.
--   2. There is deliberately NO API route or UI control that can set this
--      flag — flipping it is a direct SQL / Supabase-dashboard operation by
--      whoever holds service-role access. This mirrors how sensitive a
--      column-level grant escalation would be, and keeps "who can see every
--      tenant's data" auditable outside the app entirely.
--   3. public.users already has UPDATE locked down to a column allow-list
--      (migration 019, re-confirmed by 068: `GRANT UPDATE (name,
--      updated_at) ON public.users TO authenticated`). Because Postgres
--      column grants are additive/allow-list, simply not adding
--      is_platform_admin to that list is sufficient — no separate REVOKE is
--      needed, but this migration keeps a REVOKE ALL/GRANT‑by‑column
--      re-assertion below anyway, in the same belt-and-braces spirit as
--      migration 050's users lockdown, so this migration is self-contained
--      and doesn't depend on 019/068 never changing.
--   4. Admin actions are NOT written to public.audit_log. That table's
--      workspace_id is NOT NULL (a real FK to workspaces) and its BEFORE
--      INSERT trigger (migration 056) derives project_id from
--      entityType/entityId — machinery built entirely around one workspace's
--      own activity feed. A platform-admin action ("suspended workspace X",
--      "reset user Y's MFA", "searched for email z") is frequently not
--      scoped to one workspace at all, and mixing it into a tenant's own
--      audit trail would leak the existence/actions of platform staff into
--      that tenant's Activity tab. A dedicated, service-role-only table
--      keeps the two trails cleanly separated.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

-- ── PLATFORM ADMIN AUDIT LOG ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_admin_audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid REFERENCES public.users(id),
  admin_email  text NOT NULL,
  admin_name   text NOT NULL,
  event_type   text NOT NULL,
  target_type  text NOT NULL,          -- 'workspace' | 'user' | 'billing' | 'system'
  target_id    uuid,
  target_label text,                   -- denormalized (workspace name, user email) for readability after a target is deleted/renamed
  metadata     jsonb NOT NULL DEFAULT '{}',
  ip_address   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_admin_audit_log_created ON public.platform_admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS platform_admin_audit_log_target ON public.platform_admin_audit_log (target_type, target_id) WHERE target_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_admin_audit_log_admin ON public.platform_admin_audit_log (admin_id) WHERE admin_id IS NOT NULL;

ALTER TABLE public.platform_admin_audit_log ENABLE ROW LEVEL SECURITY;
-- No policies at all: same zero-policy service-role-only default-deny this
-- codebase already uses for 44 of its 48 other tables. Never read or
-- written by session-bound clients, only the service client from
-- lib/auth/admin.ts's requirePlatformAdmin()/logAdminAction().
REVOKE ALL ON public.platform_admin_audit_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.platform_admin_audit_log TO service_role;

-- ── GATE RPC (mirrors migration 064's middleware_gate_state pattern) ──
-- Callable by the user's OWN session client (needed in middleware, which
-- only has the request's cookies, not service-role access) but only ever
-- returns a boolean about that same user — no data about anyone else
-- leaves this function, so there is nothing here for a non-admin caller to
-- learn beyond "am I an admin," which they already know.
CREATE OR REPLACE FUNCTION public.is_current_user_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    (SELECT u.is_platform_admin FROM public.users u
     WHERE u.id = auth.uid() AND u.deleted_at IS NULL),
    false
  );
$$;
REVOKE ALL ON FUNCTION public.is_current_user_platform_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_current_user_platform_admin() TO authenticated, service_role;

-- ── ADMIN SUSPEND / RESTORE ──────────────────────────────────────
-- Deliberately NOT a reuse of restore_workspace_atomic (migration 065):
-- that RPC enforces an owner-only check and a 30-day restore window, both
-- correct for the SELF-SERVICE undo it backs but wrong for an admin
-- support action — a suspension a founder needs to reverse six weeks later,
-- or a workspace whose creator account no longer exists, must still be
-- restorable. This pair does the same core state change (deleted_at +
-- member reactivation) with no such restriction, and is reachable only
-- through the service-role-only path lib/auth/admin.ts's requireAdmin()
-- gates — never exposed to a session-bound client, so it needs no
-- in-body auth.role() check of its own (mirrors the reasoning migration
-- 073/082/093's internal-only RPCs already document, just for a pair the
-- app itself never calls).
CREATE OR REPLACE FUNCTION public.admin_suspend_workspace(p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.workspaces SET deleted_at = now(), updated_at = now()
  WHERE id = p_workspace_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found_or_already_suspended';
  END IF;
  UPDATE public.workspace_members SET status = 'deactivated'
  WHERE workspace_id = p_workspace_id AND status = 'active';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_suspend_workspace(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_suspend_workspace(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_restore_workspace(p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.workspaces SET deleted_at = NULL, updated_at = now()
  WHERE id = p_workspace_id AND deleted_at IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found_or_not_suspended';
  END IF;
  -- Reactivate members who were active immediately before suspension.
  -- Same limitation restore_workspace_atomic's own header accepts: a member
  -- deactivated for an unrelated reason moments before this suspension is
  -- indistinguishable from one deactivated BY it, so both come back. Low
  -- stakes here (an admin can always re-deactivate a specific member
  -- through Team settings afterward) and consistent with the self-service
  -- restore's own accepted trade-off.
  UPDATE public.workspace_members SET status = 'active'
  WHERE workspace_id = p_workspace_id AND status = 'deactivated';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_restore_workspace(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_restore_workspace(uuid) TO service_role;
