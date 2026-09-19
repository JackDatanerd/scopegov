-- ============================================================
-- ScopeGov — Migration 054
--
-- Two unrelated-but-both-schema-level findings from the Settings +
-- Team/Invites deep audit. Both are "the code has always assumed a value
-- the database never actually produced" bugs, which is why neither shows
-- up in any code-only diff.
--
-- ── PART 1: APPROVE_DOCUMENTS was never seeded, anywhere ──────────────
--
-- `grep -rn "APPROVE_DOCUMENTS" supabase/` returned ZERO rows before this
-- file. The permission exists in lib/supabase/types.ts (ALL_PERMISSIONS,
-- 25 entries), in lib/auth/mfa-policy.ts's MFA_REQUIRED_PERMISSIONS, in
-- lib/approvals/engine.ts's own gate, and has a dedicated regression test
-- (tests/mfa-policy.test.ts) — but create_workspace_atomic's
-- `all_permissions` blob (048, and every earlier revision of it) seeds 24
-- permissions and silently omits this one, and 008_approval_chains.sql —
-- the migration that SHIPPED approval chains — contains no `permissions`
-- statement at all.
--
-- Net effect on every workspace ever created: nobody holds
-- APPROVE_DOCUMENTS. Not even the Owner. Which means:
--   - app/(app)/settings/approvals/page.tsx maps every role and every
--     member to canApprove: false
--   - api/approval-workflows POST/PATCH reject every candidate step
--     (roleCantApprove / memberCantApprove fire on all of them)
--   - components/layout/Sidebar.tsx hides the Approvals nav item
--   - lib/approvals/engine.ts's own hasPermission gate blocks every
--     approval action
-- i.e. the entire Approval Workflows feature is dead on arrival.
--
-- And it is NOT self-recoverable: lib/utils/permission-ceiling.ts
-- enforces "you can only grant a permission you already hold." With zero
-- holders workspace-wide, no role edit and no member override can ever
-- reintroduce it. Without this migration the only fix is direct DB
-- access.
--
-- Precedent for the shape of this backfill is migration 004, which did
-- exactly this when SEND_INVOICES was added (jsonb_set against an
-- existing permission used as the proxy). The proxy used here is
-- MANAGE_WORKSPACE_SETTINGS: approving a client-facing document before
-- it goes out is an administrative act, and that's the permission the
-- seeded "Owner" role has that "Account Manager"/"Designer" deliberately
-- don't. Least privilege — this grants approval rights to admins only,
-- not to everyone, and anyone else can be granted it from Team → Roles
-- afterwards now that a holder exists to grant it.
--
-- ── PART 2: workspaces.sow_language defaulted to a value the app rejects ──
--
-- The column is `text NOT NULL DEFAULT 'en-US'` (001, line 54).
-- create_workspace_atomic never sets it, so every workspace ever created
-- sits at 'en-US'. But app/api/workspace/settings/route.ts validates
-- against the closed set lib/ai/sow-content.ts actually has translated
-- boilerplate for — ['en','es','fr','pt','de','sw'] — and 'en-US' is not
-- in it.
--
-- Because Settings → Workspace submits the WHOLE form object on save
-- (both its buttons post `form`, which carries sowLanguage seeded from
-- this column), that made the entire Workspace tab — Identity AND
-- Billing identity — unsaveable on every untouched workspace: change the
-- agency name, hit save, get back "Unsupported SOW language" naming a
-- field nobody touched. The <select> hid it completely: 'en-US' matches
-- no <option>, so the browser paints "English" while state still holds
-- the rejected value.
--
-- Normalize the stored data and fix the default so the column can only
-- ever produce a value the app accepts. The route also normalizes
-- defensively (see its own comment) so a legacy regional code arriving
-- from an old client is coerced rather than rejected.
-- ============================================================

-- ── PART 1a: backfill roles.permissions ──────────────────────────────
-- Only touches roles that don't already carry an explicit
-- APPROVE_DOCUMENTS key, so a workspace that somehow already configured
-- it (or that runs this migration twice) is never overwritten.
UPDATE public.roles
SET permissions = jsonb_set(
      permissions,
      '{APPROVE_DOCUMENTS}',
      COALESCE(permissions->'MANAGE_WORKSPACE_SETTINGS', 'false'::jsonb)
    ),
    updated_at = now()
WHERE NOT (permissions ? 'APPROVE_DOCUMENTS');

-- ── PART 1b: backfill workspace_members.effective_permissions ─────────
-- trg_role_permissions_propagate only fires on UPDATE OF permissions on
-- `roles`, so 1a above would normally cascade on its own. It's written
-- out explicitly anyway for members whose row somehow didn't get
-- recomputed (a member with permission_overrides, or one whose role_id
-- is NULL and therefore isn't reached by that trigger at all).
UPDATE public.workspace_members
SET effective_permissions = jsonb_set(
      effective_permissions,
      '{APPROVE_DOCUMENTS}',
      COALESCE(effective_permissions->'MANAGE_WORKSPACE_SETTINGS', 'false'::jsonb)
    )
WHERE NOT (effective_permissions ? 'APPROVE_DOCUMENTS');

-- ── PART 1c: seed it on every NEW workspace ──────────────────────────
-- Same body as 048 (trial lifetime cap) in every other respect — only
-- the all_permissions blob changes, gaining the 25th permission. Kept as
-- a full CREATE OR REPLACE rather than an ALTER because the blob is a
-- literal inside the function body.
CREATE OR REPLACE FUNCTION public.create_workspace_atomic(
  p_workspace_id  uuid,
  p_user_id       uuid,
  p_name          text,
  p_slug          text,
  p_agency_name   text,
  p_industry      text,
  p_currency      text,
  p_timezone      text,
  p_jwt_secret    text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  -- FIX (migration 054): APPROVE_DOCUMENTS added -- see this file's header.
  all_permissions := '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":true,
    "VIEW_CLIENT_DATA":true,"CREATE_PROJECTS":true,"EDIT_SOW":true,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":true,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":true,
    "GRANT_EXCEPTIONS":true,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":true,"MANAGE_ROLES":true,
    "MANAGE_BILLING":true,"EXPORT_DATA":true,"DELETE_PROJECTS":true,
    "VIEW_AUDIT_LOG":true,"MANAGE_WORKSPACE_SETTINGS":true,"SEND_INVOICES":true,
    "APPROVE_DOCUMENTS":true
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
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":true,
    "APPROVE_DOCUMENTS":false
  }'::jsonb, true, p_user_id),
  (p_workspace_id, 'Designer', '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":false,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":false,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":false,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":false,
    "APPROVE_DOCUMENTS":false
  }'::jsonb, false, p_user_id),
  (p_workspace_id, 'Project Coordinator', '{
    "VIEW_OWN_PROJECTS":false,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false,"SEND_INVOICES":false,
    "APPROVE_DOCUMENTS":false
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
$$;

REVOKE ALL ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace_atomic(
  uuid, uuid, text, text, text, text, text, text, text
) TO service_role;

-- ── PART 2: normalize sow_language ───────────────────────────────────
-- Map any regional variant ('en-US', 'pt_BR', 'FR') onto the base code
-- the generator understands, and drop anything unrecognized to 'en'
-- rather than leaving a value that would 400 the whole Workspace tab.
UPDATE public.workspaces
SET sow_language = CASE
      WHEN lower(split_part(replace(sow_language, '_', '-'), '-', 1))
           IN ('en','es','fr','pt','de','sw')
      THEN lower(split_part(replace(sow_language, '_', '-'), '-', 1))
      ELSE 'en'
    END
WHERE sow_language NOT IN ('en','es','fr','pt','de','sw');

ALTER TABLE public.workspaces
  ALTER COLUMN sow_language SET DEFAULT 'en';

-- Backstop so the column can never again hold a value the app rejects.
ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_sow_language_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_sow_language_check
  CHECK (sow_language IN ('en','es','fr','pt','de','sw'));
