-- ============================================================
-- ScopeGov — Migration 059: RLS+permissions independent re-pass,
-- round 2 — Postgres-replay findings
--
-- Found by actually installing Postgres locally, bootstrapping real
-- anon/authenticated/service_role roles + default privileges the way a
-- fresh Supabase project does, replaying all 58 prior migrations against
-- it, seeding two isolated fake tenants, and querying/calling as each
-- role directly — not just reading the SQL. Same methodology as 055,
-- pointed at a different corner: every SECURITY DEFINER function's own
-- grants, checked by calling each one directly via the exact RPC path
-- PostgREST exposes, rather than only through the call sites this
-- codebase's own routes use.
--
-- (A) set_default_role_atomic (049) — CRITICAL, verified end-to-end.
--     SECURITY DEFINER, takes p_workspace_id/p_new_role_id as raw
--     parameters, and — unlike every sibling atomic RPC in this file
--     (leave_workspace_atomic, transfer_workspace_ownership,
--     update_role_permissions_atomic, update_member_permissions_atomic,
--     purge_project, purge_workspace, create_workspace_atomic,
--     assign_document_number, append_scope_deliverables, all correctly
--     REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ...
--     TO service_role) — was never given that lockdown. It shipped on
--     Supabase's default ALTER DEFAULT PRIVILEGES grant, callable by any
--     logged-in user via POST /rest/v1/rpc/set_default_role_atomic.
--
--     Reproduced directly: seeded a workspace, added a member holding
--     only the "Designer" preset role (none of MANAGE_ROLES,
--     INVITE_MEMBERS, MANAGE_WORKSPACE_SETTINGS), then called this RPC
--     as that member — as `authenticated`, with request.jwt.claim.sub
--     set to their own id, exactly as PostgREST would — naming their own
--     workspace's "Owner" role (permissions=all-true) as the new
--     default. It worked: is_default flipped from the seeded default to
--     Owner, with zero permission check, zero audit log entry, and the
--     entire Next.js API layer (hasPermission, permission-ceiling.ts,
--     admin-floor.ts) never in the call path at all, because this hits
--     Postgres directly. The next person who accepts an invite to that
--     workspace would silently be granted full Owner permissions. The
--     role id an attacker needs is not even privileged information —
--     GET /api/team/roles already returns every role's id+name to any
--     authenticated member regardless of permissions.
--
--     Fix: identical lockdown shape as every sibling RPC. The one
--     existing caller (app/api/team/roles/route.ts, POST) already calls
--     this via the service-role client, so locking it down changes
--     nothing about how the app itself uses it.
--
-- (B) is_active_workspace_member (055) — MODERATE, verified.
--     Correctly grantable to anon/authenticated (the "workspaces_member"
--     policy has to be able to call it as the querying role), but the
--     function itself never checked that p_user_id — a caller-supplied
--     parameter, not something Postgres derives — actually equals
--     auth.uid(). Called from the policy, it always is, so the policy's
--     own use of it was never at risk. Called directly via RPC — which
--     the EXECUTE grant equally permits, since Postgres grants don't
--     distinguish "invoked by a policy" from "invoked by a client" — an
--     authenticated user can pass ANY user id and ANY workspace id and
--     get back whether that (arbitrary) user is an active member of
--     that (arbitrary) workspace. Reproduced directly: Alice, a member
--     of Tenant A with no relationship to Tenant B, called
--     is_active_workspace_member(<Tenant B's id>, <Bob's id>) and got
--     back `true`, confirming Bob's membership in a workspace Alice has
--     no visibility into by any other means.
--
--     Fix: pin the check to the actual caller inside the function body
--     — same signature, so the policy's call site (and every grant)
--     needs no change, but a value can now only ever be checked against
--     the caller's own auth.uid(), never an arbitrary third party's.
--     Correctly still returns false (not an error) for anon, matching
--     the original "harmless" reasoning: auth.uid() is null for anon,
--     so p_user_id = auth.uid() is null = never true.
--
-- (C) audit_resolve_project_id (056) — minor, same root cause as (A).
--     SECURITY DEFINER, resolves an arbitrary entity_id (any tenant's)
--     to its project_id, never locked down, so any authenticated/anon
--     caller can call it directly for cross-tenant entities they have
--     no other access to. Low-value disclosure (a UUID linkage) since
--     it requires already knowing a valid foreign entity id, but same
--     missing-lockdown pattern as (A) and no legitimate reason for
--     direct client-facing access — its only real caller is the
--     audit_log_set_project_id trigger, which fires only on inserts
--     that always come from the service-role client (logAudit()).
-- ============================================================

-- ── (A) set_default_role_atomic: close the open RPC ─────────────────────
REVOKE ALL ON FUNCTION public.set_default_role_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_default_role_atomic(uuid, uuid) TO service_role;

-- ── (B) is_active_workspace_member: pin the check to the real caller ────
CREATE OR REPLACE FUNCTION public.is_active_workspace_member(p_workspace_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id
      AND user_id = p_user_id
      AND status = 'active'
      -- The one line that closes the oracle: no caller can ever ask
      -- about anyone but themselves, directly-called or not.
      AND p_user_id = auth.uid()
  )
$$;
-- Grants unchanged from 055 — still needs to be callable by the
-- "workspaces_member" policy as anon/authenticated; the fix is entirely
-- inside the function body, not the grant.

-- ── (C) audit_resolve_project_id: close the open RPC ────────────────────
REVOKE ALL ON FUNCTION public.audit_resolve_project_id(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_resolve_project_id(text, uuid, jsonb) TO service_role;
