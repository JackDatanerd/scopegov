-- ============================================================
-- ScopeGov — Master Database Migration
-- Spec v11 compliant. Run once on a fresh Supabase project.
-- ============================================================

-- ── EXTENSIONS ────────────────────────────────────────────────
-- uuid-ossp is NOT used — gen_random_uuid() is a PostgreSQL built-in
-- available without any extension in PG 13+ (all Supabase projects).
-- uuid-ossp installs in the 'extensions' schema; functions with
-- SET search_path = public can't see it, causing runtime errors.
CREATE EXTENSION IF NOT EXISTS "vector";

-- ── ENUMS ─────────────────────────────────────────────────────
-- BUG-044: plan type includes all tiers
CREATE TYPE plan_tier AS ENUM ('trial','solo','starter','pro','agency');

CREATE TYPE project_type AS ENUM (
  'web','mobile','brand','ecomm','marketing','retainer','video','other'
);

-- BUG-037 carry-forward: 'sent' is NOT a status. 'escalated' is NOT a status.
CREATE TYPE project_status AS ENUM (
  'Draft','Intake','Awaiting Signature','Changes Requested',
  'Active','Stalled','Complete','Archived'
);

-- ── USERS ─────────────────────────────────────────────────────
-- Mirrors auth.users with application-level data
CREATE TABLE IF NOT EXISTS public.users (
  id                          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                       text NOT NULL UNIQUE,
  name                        text NOT NULL DEFAULT '',
  avatar_url                  text,
  active_workspace_id         uuid,
  email_verified_at           timestamptz,
  deleted_at                  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ── WORKSPACES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspaces (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL,
  slug                        text NOT NULL UNIQUE,
  slug_changed_at             timestamptz,
  jwt_secret                  text NOT NULL, -- never in API responses (BUG-062)
  agency_name                 text NOT NULL,
  brand_colour                text NOT NULL DEFAULT '#1A5C3A',
  logo_storage_path           text,
  industry                    text NOT NULL,
  currency                    text NOT NULL DEFAULT 'USD',
  timezone                    text NOT NULL DEFAULT 'Africa/Nairobi',
  sow_language                text NOT NULL DEFAULT 'en-US',
  governing_law               text NOT NULL DEFAULT 'Republic of Kenya',
  proactive_risk_threshold    decimal NOT NULL DEFAULT 10000,
  proactive_risk_alerts_enabled boolean NOT NULL DEFAULT true,
  plan_tier                   plan_tier NOT NULL DEFAULT 'trial',
  trial_ends_at               timestamptz,
  onboarding_completed_at     timestamptz,
  first_sow_signed_at         timestamptz,
  deleted_at                  timestamptz,
  created_by                  uuid NOT NULL REFERENCES public.users(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ── ROLES ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  permissions   jsonb NOT NULL DEFAULT '{}',
  is_default    boolean NOT NULL DEFAULT false,
  created_by    uuid NOT NULL REFERENCES public.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- One default role per workspace
CREATE UNIQUE INDEX IF NOT EXISTS roles_one_default
  ON public.roles (workspace_id) WHERE is_default = true;

-- ── WORKSPACE MEMBERS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspace_members (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Nullable: a pending invite for someone without a ScopeGov account yet has
  -- no user_id until they accept. invited_email carries the target address
  -- until then. BUG-FIX: was NOT NULL, which made every "invite a new person"
  -- call fail with a constraint violation.
  user_id               uuid REFERENCES public.users(id),
  invited_email         text,
  role_id               uuid REFERENCES public.roles(id),
  permission_overrides  jsonb,
  effective_permissions jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('active','invited','deactivated')),
  invite_token          text UNIQUE,
  invite_token_expires_at timestamptz,
  invited_at            timestamptz,
  joined_at             timestamptz,
  deactivated_at        timestamptz,
  invited_by            uuid REFERENCES public.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user ON public.workspace_members(user_id) WHERE user_id IS NOT NULL;
-- Prevent duplicate pending invites to the same email within a workspace
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_pending_email
  ON public.workspace_members(workspace_id, invited_email)
  WHERE status = 'invited' AND invited_email IS NOT NULL;

-- ── TRIGGER A: recompute effectivePermissions on member change ─
CREATE OR REPLACE FUNCTION compute_effective_permissions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  role_perms jsonb := '{}';
  overrides  jsonb := '{}';
  merged     jsonb := '{}';
  key        text;
BEGIN
  -- Get base role permissions
  IF NEW.role_id IS NOT NULL THEN
    SELECT permissions INTO role_perms FROM public.roles WHERE id = NEW.role_id;
  END IF;
  -- Merge with overrides (overrides win per-key)
  overrides := COALESCE(NEW.permission_overrides, '{}');
  merged := role_perms;
  FOR key IN SELECT jsonb_object_keys(overrides) LOOP
    merged := jsonb_set(merged, ARRAY[key], overrides->key);
  END LOOP;
  NEW.effective_permissions := merged;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_member_effective_permissions
  BEFORE INSERT OR UPDATE OF permission_overrides, role_id
  ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION compute_effective_permissions();

-- ── TRIGGER B: recompute when role permissions change ─────────
CREATE OR REPLACE FUNCTION propagate_role_permissions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  member_row RECORD;
  overrides  jsonb;
  merged     jsonb := '{}';
  key        text;
BEGIN
  FOR member_row IN
    SELECT id, permission_overrides
    FROM public.workspace_members
    WHERE role_id = NEW.id
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

CREATE OR REPLACE TRIGGER trg_role_permissions_propagate
  AFTER UPDATE OF permissions ON public.roles
  FOR EACH ROW EXECUTE FUNCTION propagate_role_permissions();

-- ── CLIENTS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  company_name    text,
  email           text NOT NULL,
  cc_emails       text[] NOT NULL DEFAULT '{}',
  phone           text,
  timezone        text,
  billing_address jsonb,
  vat_number      text,
  payment_terms_note text,
  notes           text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, email)
);

CREATE TABLE IF NOT EXISTS public.client_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text NOT NULL,
  role        text,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS client_contacts_one_primary
  ON public.client_contacts(client_id) WHERE is_primary = true;

-- ── PROJECTS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.projects (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  client_id               uuid NOT NULL REFERENCES public.clients(id),
  name                    text NOT NULL,
  disc                    text,
  type                    project_type NOT NULL,
  status                  project_status NOT NULL DEFAULT 'Draft',
  stall_reason            text CHECK (stall_reason IN ('sow_unsigned','manual')),
  contract_value          decimal NOT NULL DEFAULT 0,
  currency                text NOT NULL DEFAULT 'USD',
  guardian_email          text,
  start_date              date,
  internal_ref            text,
  retainer_duration_months integer,
  onboarding_source       text,
  created_by              uuid NOT NULL REFERENCES public.users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz
);
CREATE INDEX IF NOT EXISTS projects_workspace ON public.projects(workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.project_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.workspace_members(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  added_by    uuid NOT NULL REFERENCES public.users(id),
  UNIQUE(project_id, member_id)
);
CREATE INDEX IF NOT EXISTS project_members_member ON public.project_members(member_id);

-- ── SOW DOCUMENTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sow_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES public.projects(id),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','awaiting_signature','signed',
                             'declined','changes_requested','withdrawn','expired')),
  sent_at             timestamptz,
  signed_at           timestamptz,
  signed_by           text,
  signer_email        text,
  signer_ip           text,
  declined_at         timestamptz,
  declined_reason     text,
  expires_at          timestamptz,
  token               text UNIQUE,
  previous_version_id uuid REFERENCES public.sow_documents(id),
  sections            jsonb NOT NULL DEFAULT '[]',
  metadata            jsonb NOT NULL DEFAULT '{}',
  pdf_path            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sow_documents_project ON public.sow_documents(project_id, version DESC);

CREATE TABLE IF NOT EXISTS public.sow_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sow_id       uuid NOT NULL REFERENCES public.sow_documents(id) ON DELETE CASCADE,
  file_name    text NOT NULL,
  file_size    integer NOT NULL,
  mime_type    text NOT NULL,
  storage_path text NOT NULL,
  uploaded_by  uuid NOT NULL REFERENCES public.users(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sow_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  project_type project_type NOT NULL,
  sections     jsonb NOT NULL DEFAULT '[]',
  is_default   boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  created_by   uuid NOT NULL REFERENCES public.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sow_templates_one_default
  ON public.sow_templates(workspace_id, project_type) WHERE is_default = true;

CREATE TABLE IF NOT EXISTS public.workspace_defaults (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_type        project_type,
  revision_policy     text,
  payment_terms       text,
  out_of_scope_clauses text[],
  assumptions         text[],
  governing_law       text,
  payment_structure   text,
  payment_split       text,
  revision_rounds     integer DEFAULT 2,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, project_type)
);

-- ── PAYMENT MILESTONES ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_milestones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  sow_id       uuid NOT NULL REFERENCES public.sow_documents(id),
  title        text NOT NULL,
  type         text NOT NULL CHECK (type IN ('fixed','percentage','hourly_cap','retainer_monthly')),
  amount       decimal NOT NULL,
  percentage   decimal,
  trigger      text NOT NULL,
  tax_rate     decimal NOT NULL DEFAULT 0,
  tax_inclusive boolean NOT NULL DEFAULT false,
  due_date     date,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','invoiced','paid','overdue')),
  invoiced_at  timestamptz,
  paid_at      timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_milestones_project ON public.payment_milestones(project_id);

-- ── CHANGE ORDERS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.change_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES public.projects(id),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  flag_id             uuid,
  parent_co_id        uuid REFERENCES public.change_orders(id),
  version             integer NOT NULL DEFAULT 1,
  title               text NOT NULL,
  note                text,
  -- 'escalated' is NOT a status value (BUG-049, spec §1.5)
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','awaiting_response','accepted','declined',
                             'countered','closed','stalled','withdrawn','exception_granted')),
  line_items          jsonb NOT NULL DEFAULT '[]',
  subtotal            decimal NOT NULL DEFAULT 0,
  tax_rate            decimal NOT NULL DEFAULT 0,
  tax_inclusive       boolean NOT NULL DEFAULT false,
  total               decimal NOT NULL DEFAULT 0,
  sent_at             timestamptz,
  responded_at        timestamptz,
  accepted_at         timestamptz,  -- unconditionally set on ALL acceptance paths (BUG-047)
  accepted_by         text,
  counter_amount      decimal,
  counter_note        text,
  counter_accepted_at timestamptz,
  counter_accepted_by text,
  declined_at         timestamptz,
  declined_reason     text,
  close_reason        text,
  exception_reason    text,
  exception_value     decimal,
  escalated_to        uuid REFERENCES public.users(id),
  escalation_note     text,
  token               text UNIQUE,
  expires_at          timestamptz,
  is_retainer_renewal boolean NOT NULL DEFAULT false,
  assigned_to         uuid REFERENCES public.users(id),
  created_by          uuid NOT NULL REFERENCES public.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_orders_project_status ON public.change_orders(project_id, status);

CREATE TABLE IF NOT EXISTS public.amendments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES public.projects(id),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  change_order_id     uuid NOT NULL REFERENCES public.change_orders(id),
  signed_sow_id       uuid NOT NULL REFERENCES public.sow_documents(id),
  title               text NOT NULL,
  added_deliverables  text[] NOT NULL DEFAULT '{}',
  removed_deliverables text[] NOT NULL DEFAULT '{}',
  financial_impact    decimal NOT NULL,
  effective_at        timestamptz NOT NULL,
  pdf_path            text NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS amendments_project ON public.amendments(project_id);

CREATE TABLE IF NOT EXISTS public.co_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  co_id        uuid NOT NULL REFERENCES public.change_orders(id) ON DELETE CASCADE,
  file_name    text NOT NULL,
  file_size    integer NOT NULL,
  mime_type    text NOT NULL,
  storage_path text NOT NULL,
  uploaded_by  uuid NOT NULL REFERENCES public.users(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

-- ── GUARDIAN ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES public.projects(id),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  check_id      uuid,
  change_order_id uuid REFERENCES public.change_orders(id),
  type          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('high','medium','low')),
  description   text NOT NULL,
  sow_reference text NOT NULL,
  -- 'escalated' is NOT a status value (BUG-049, spec §1.6)
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','resolved','closed','converted_to_co')),
  resolution    text CHECK (resolution IN ('change_order','exception','closed')),
  resolved_by   uuid REFERENCES public.users(id),
  resolved_at   timestamptz,
  close_reason  text,
  escalated_to  uuid REFERENCES public.users(id),
  escalation_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guardian_flags_project_status ON public.guardian_flags(project_id, status);
CREATE INDEX IF NOT EXISTS guardian_flags_co ON public.guardian_flags(change_order_id) WHERE change_order_id IS NOT NULL;

-- Add FK after both tables exist
ALTER TABLE public.change_orders
  ADD CONSTRAINT fk_co_flag FOREIGN KEY (flag_id) REFERENCES public.guardian_flags(id);

CREATE TABLE IF NOT EXISTS public.guardian_checks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.projects(id),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  content               text NOT NULL,
  source                text NOT NULL CHECK (source IN ('email','paste','slack','webhook')),
  source_metadata       jsonb,
  submitted_by          uuid REFERENCES public.users(id),
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  is_retroactive        boolean NOT NULL DEFAULT false,
  is_duplicate          boolean NOT NULL DEFAULT false,
  duplicate_of_id       uuid REFERENCES public.guardian_checks(id),
  -- Embedding computed for ALL submissions for dedup; only persisted for non-duplicates (BUG-060)
  embedding             vector(1536),
  match_confidence      decimal,
  creep_confidence      decimal,
  matched_against       text CHECK (matched_against IN ('sow','amendment')),
  matched_reference     text,
  matched_amendment_id  uuid REFERENCES public.amendments(id),
  outcome               text NOT NULL DEFAULT 'pending'
                        CHECK (outcome IN ('pending','in_scope','borderline','out_of_scope','covered_by_co')),
  classified_at         timestamptz,
  classification_failed boolean NOT NULL DEFAULT false,
  flag_id               uuid REFERENCES public.guardian_flags(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guardian_checks_project ON public.guardian_checks(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guardian_checks_embedding ON public.guardian_checks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE public.guardian_flags
  ADD CONSTRAINT fk_flag_check FOREIGN KEY (check_id) REFERENCES public.guardian_checks(id);

CREATE TABLE IF NOT EXISTS public.project_scope_snapshot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES public.projects(id) UNIQUE,
  deliverables    jsonb[] NOT NULL DEFAULT '{}',
  out_of_scope    jsonb[] NOT NULL DEFAULT '{}',
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  last_updated_by text NOT NULL CHECK (last_updated_by IN ('signing','amendment','scope_adjustment'))
);

CREATE TABLE IF NOT EXISTS public.scope_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.projects(id),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  deliverable  text NOT NULL,
  old_value    text NOT NULL,
  new_value    text NOT NULL,
  reason       text NOT NULL,
  adjusted_by  uuid NOT NULL REFERENCES public.users(id),
  adjusted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scope_adjustments_project ON public.scope_adjustments(project_id);

CREATE TABLE IF NOT EXISTS public.exceptions_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.projects(id),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  flag_id      uuid REFERENCES public.guardian_flags(id),
  deliverable  text NOT NULL,
  granted_what text NOT NULL,
  granted_by   uuid NOT NULL REFERENCES public.users(id),
  estimated_value decimal NOT NULL,
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── NOTIFICATIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.users(id),
  type         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,
  entity_type  text,
  entity_id    uuid,
  read         boolean NOT NULL DEFAULT false,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_recipient
  ON public.notifications(recipient_id, workspace_id, created_at DESC) WHERE read = false;

CREATE TABLE IF NOT EXISTS public.workspace_notification_defaults (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  email_enabled boolean NOT NULL DEFAULT true,
  in_app_enabled boolean NOT NULL DEFAULT true,
  locked        boolean NOT NULL DEFAULT false,
  UNIQUE(workspace_id, event_type)
);

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.users(id),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_type     text NOT NULL,
  email_enabled  boolean NOT NULL,
  in_app_enabled boolean NOT NULL,
  UNIQUE(user_id, workspace_id, event_type)
);

-- ── AUDIT LOG ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  actor_id     uuid REFERENCES public.users(id),
  actor_email  text NOT NULL,
  actor_name   text NOT NULL,
  event_type   text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  entity_name  text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  ip_address   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_workspace ON public.audit_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity ON public.audit_log(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_actor ON public.audit_log(actor_id) WHERE actor_id IS NOT NULL;

-- ── REVOKED TOKENS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.revoked_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token      text NOT NULL UNIQUE,
  token_type text NOT NULL CHECK (token_type IN ('sow','co')),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  reason     text NOT NULL CHECK (reason IN ('withdrawn','declined','superseded','manual')),
  revoked_by uuid REFERENCES public.users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS revoked_tokens_token ON public.revoked_tokens(token);

-- ── DOCUMENT EDIT LOCKS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_edit_locks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('sow','co')),
  locked_by   uuid NOT NULL REFERENCES public.users(id),
  locked_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  UNIQUE(document_id)
);

-- ── BILLING ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE UNIQUE,
  paystack_customer_code      text,
  paystack_subscription_code  text,
  -- Required by Paystack's /subscription/disable endpoint alongside the
  -- subscription code. Returned on subscription.create — persist it then,
  -- or cancellation calls will always send token: undefined and fail.
  paystack_email_token        text,
  cancels_at_period_end       boolean NOT NULL DEFAULT false,
  current_period_end          timestamptz,
  payment_method_last4        text,
  payment_method_type         text,
  grace_period_started_at     timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ── FULL-TEXT SEARCH ──────────────────────────────────────────
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(disc,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS projects_search ON public.projects USING GIN(search_vector);

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(company_name,'') || ' ' || email)
  ) STORED;
CREATE INDEX IF NOT EXISTS clients_search ON public.clients USING GIN(search_vector);

-- ── ATOMIC WORKSPACE CREATION ─────────────────────────────────
-- Called from API: creates workspace + owner member in one transaction (spec §1.0)
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
BEGIN
  -- Build owner permissions (all 24 on)
  all_permissions := '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":true,
    "VIEW_CLIENT_DATA":true,"CREATE_PROJECTS":true,"EDIT_SOW":true,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":true,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":true,
    "GRANT_EXCEPTIONS":true,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":true,"MANAGE_ROLES":true,
    "MANAGE_BILLING":true,"EXPORT_DATA":true,"DELETE_PROJECTS":true,
    "VIEW_AUDIT_LOG":true,"MANAGE_WORKSPACE_SETTINGS":true
  }'::jsonb;

  -- 1. Insert workspace
  INSERT INTO public.workspaces (
    id, name, slug, jwt_secret, agency_name, industry, currency, timezone,
    plan_tier, trial_ends_at, created_by
  ) VALUES (
    p_workspace_id, p_name, p_slug, p_jwt_secret, p_agency_name, p_industry,
    p_currency, p_timezone, 'trial', now() + interval '14 days', p_user_id
  );

  -- 2. Create Owner role
  INSERT INTO public.roles (id, workspace_id, name, permissions, is_default, created_by)
  VALUES (gen_random_uuid(), p_workspace_id, 'Owner', all_permissions, false, p_user_id)
  RETURNING id INTO owner_role_id;

  -- Also create preset roles
  INSERT INTO public.roles (workspace_id, name, permissions, is_default, created_by) VALUES
  (p_workspace_id, 'Account Manager', '{
    "VIEW_OWN_PROJECTS":false,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":true,
    "VIEW_CLIENT_DATA":true,"CREATE_PROJECTS":true,"EDIT_SOW":true,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":true,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":true,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":true,
    "MARK_PROJECT_COMPLETE":true,"ASSIGN_TEAM_MEMBERS":true,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false
  }'::jsonb, true, p_user_id),
  (p_workspace_id, 'Designer', '{
    "VIEW_OWN_PROJECTS":true,"VIEW_ALL_PROJECTS":false,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":false,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":false,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false
  }'::jsonb, false, p_user_id),
  (p_workspace_id, 'Project Coordinator', '{
    "VIEW_OWN_PROJECTS":false,"VIEW_ALL_PROJECTS":true,"VIEW_FINANCIALS":false,
    "VIEW_CLIENT_DATA":false,"CREATE_PROJECTS":false,"EDIT_SOW":false,"SEND_SOW":true,
    "CREATE_CHANGE_ORDERS":false,"SEND_CHANGE_ORDERS":true,"APPROVE_FLAGS":false,
    "GRANT_EXCEPTIONS":false,"MARK_DELIVERABLE_STATUS":true,"MARK_PAYMENT_MILESTONES":false,
    "MARK_PROJECT_COMPLETE":false,"ASSIGN_TEAM_MEMBERS":false,"SUBMIT_GUARDIAN_CHECKS":true,
    "ACCESS_GUARDIAN_HISTORY":true,"INVITE_MEMBERS":false,"MANAGE_ROLES":false,
    "MANAGE_BILLING":false,"EXPORT_DATA":false,"DELETE_PROJECTS":false,
    "VIEW_AUDIT_LOG":false,"MANAGE_WORKSPACE_SETTINGS":false
  }'::jsonb, false, p_user_id);

  -- 3. Add creator as active Owner member (spec §1.0: invitedBy=NULL, status=active)
  INSERT INTO public.workspace_members (
    workspace_id, user_id, role_id, effective_permissions,
    status, joined_at, invited_by
  ) VALUES (
    p_workspace_id, p_user_id, owner_role_id, all_permissions,
    'active', now(), NULL
  );

  -- 4. Update user's active workspace
  UPDATE public.users SET active_workspace_id = p_workspace_id WHERE id = p_user_id;
END;
$$;

-- ── HANDLE NEW USER TRIGGER ───────────────────────────────────
-- BUG-003: SECURITY DEFINER, creates profile row on auth signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.users (id, email, name, email_verified_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', ''),
    CASE WHEN NEW.email_confirmed_at IS NOT NULL THEN NEW.email_confirmed_at ELSE NULL END
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        name  = CASE WHEN public.users.name = '' THEN EXCLUDED.name ELSE public.users.name END,
        email_verified_at = COALESCE(public.users.email_verified_at, EXCLUDED.email_verified_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── RLS ───────────────────────────────────────────────────────
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sow_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amendments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guardian_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guardian_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_scope_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_milestones ENABLE ROW LEVEL SECURITY;

-- Users: own row
CREATE POLICY "users_own" ON public.users
  FOR ALL USING (auth.uid() = id);
-- BUG-002: INSERT policy required
CREATE POLICY "users_insert_own" ON public.users
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Workspace members: see own memberships
CREATE POLICY "members_own" ON public.workspace_members
  FOR SELECT USING (user_id = auth.uid());

-- Workspaces: member can see their workspace
CREATE POLICY "workspaces_member" ON public.workspaces
  FOR SELECT USING (
    id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid() AND status = 'active')
  );

-- Service role bypasses all RLS (used for admin operations)
-- All other tables follow the same workspace-scoped pattern via service role in API routes
