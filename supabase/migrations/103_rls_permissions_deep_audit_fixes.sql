-- 103_rls_permissions_deep_audit_fixes.sql
--
-- Fresh, independent audit of RLS + permissions (supabase/migrations, lib/supabase,
-- permission-ceiling.ts/.test.ts), Postgres-replay method (every prior FIX comment
-- treated as if it didn't exist; checked against real Postgres function-signature/
-- privilege semantics, not just re-read).
--
-- FIX 1 (CRITICAL — anon/authenticated RPC exposure via a signature change):
-- Migration 069 created decide_approval_step(uuid,uuid,text,uuid,text) [5 args] and
-- correctly locked it to service_role:
--   REVOKE ALL ON FUNCTION public.decide_approval_step(uuid, uuid, text, uuid, text)
--     FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.decide_approval_step(uuid, uuid, text, uuid, text)
--     TO service_role;
--
-- Migration 095 (the reassign-vs-decide race fix) replaced it with a DIFFERENT
-- signature — decide_approval_step(uuid,uuid,text,uuid,text,uuid,uuid) [7 args], adding
-- p_expected_approver_user_id/p_expected_approver_role_id. In Postgres, a function is
-- identified by (schema, name, argument TYPES) — CREATE OR REPLACE with a changed
-- argument list does not "replace" the old grants, it creates a genuinely NEW catalog
-- object, which receives Supabase's default EXECUTE grant to PUBLIC/anon/authenticated
-- unless explicitly revoked. 095 only dropped the OLD 5-arg function
-- (`DROP FUNCTION IF EXISTS public.decide_approval_step(uuid, uuid, text, uuid, text)`)
-- and never re-issued the REVOKE/GRANT pair for the new 7-arg one — so the new function
-- has sat open to anon/authenticated ever since 095 shipped (migrations 096-099 didn't
-- touch it).
--
-- This is the ONLY function in the schema's history whose signature ever changed across
-- a CREATE OR REPLACE (checked every function name against every migration) — everywhere
-- else this codebase's own "every new/changed function gets an explicit REVOKE/GRANT
-- pair" discipline held. It broke exactly once, on exactly the function where it matters
-- most: decide_approval_step is SECURITY DEFINER and does NO caller-identity check at
-- all — p_actor_id is fully caller-supplied and written straight into decided_by, with
-- no auth.uid() comparison or workspace-membership check anywhere in the body. Left
-- exposed, any authenticated (or anon) API caller who supplies a request_id/step_id and
-- the matching p_expected_approver_user_id/role_id could approve or reject ANY approval
-- step in ANY workspace under a forged actor identity — a complete bypass of every check
-- in lib/approvals/engine.ts (APPROVE_DOCUMENTS, per-step eligibility, self-approval,
-- four-eyes, canReadProject).
--
-- Also closes the blind spot that let this ship silently: rls-contract.test.ts's static
-- functionExposure() scanner keys its exposure map by function NAME only, so it wrongly
-- carried the OLD 5-arg function's "revoked" state onto the NEW 7-arg one and reported
-- this as safe. pg-replay.test.ts (which replays real migrations against real Postgres
-- and is signature-correct) would have caught it, but nothing in this repo's CI
-- provisions PG_REPLAY_URL, so it never actually ran.
REVOKE ALL ON FUNCTION public.decide_approval_step(
  uuid, uuid, text, uuid, text, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_approval_step(
  uuid, uuid, text, uuid, text, uuid, uuid
) TO service_role;

-- FIX 2 (LOW / hygiene — missing explicit REVOKE on a view):
-- project_members_active (migration 070, redefined 083) is the only VIEW in the schema
-- and the only new relation since migration 068 that never got the explicit
-- `REVOKE ALL ... FROM PUBLIC, anon, authenticated` every other new table/view in this
-- codebase receives on creation (see 013, 026, 056, 062, 064, 068, 090, 094 for the
-- pattern; 090's own header comment explains why: migration 068's blanket
-- `ALTER DEFAULT PRIVILEGES` is wrapped in an exception handler that itself warns it may
-- silently no-op depending on which role owns the schema defaults, so nothing downstream
-- should rely on it alone). Actual exposure risk is low — the view is
-- `WITH (security_invoker = true)`, and every table it joins (project_members, projects,
-- workspace_members) already grants zero SELECT privilege to anon/authenticated, so an
-- invoker without table-level access sees no rows regardless of the view's own grant —
-- but it should still get the same explicit lockdown as everything else, on principle and
-- so a future privilege change to one of those underlying tables can't silently combine
-- with this gap.
REVOKE ALL ON public.project_members_active FROM PUBLIC, anon, authenticated;
