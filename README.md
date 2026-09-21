# ScopeGov — Deployment Runbook

## Stack
- **Framework:** Next.js 14 (App Router)
- **Database:** Supabase (Postgres + RLS + pgvector)
- **Auth:** Supabase Auth
- **Email:** Resend (transactional) + Postmark (inbound)
- **Payments:** Paystack
- **AI:** Anthropic Claude (SOW gen, Guardian classification) + OpenAI (embeddings)
- **PDF:** Puppeteer (server-side, Node runtime)
- **Deploy:** Vercel

---

## 1. Supabase Setup

### 1.1 Database
```bash
# Run the migrations in order:
# supabase/migrations/001_initial_schema.sql
# supabase/migrations/002_signatures.sql
# supabase/migrations/003_document_numbering.sql
# supabase/migrations/004_invoicing.sql
# supabase/migrations/005_contract_reconciliation.sql
# supabase/migrations/006_mfa_backup_codes.sql
# supabase/migrations/007_scope_health.sql
# supabase/migrations/008_approval_chains.sql
# supabase/migrations/009_project_messages.sql
# Execute via Supabase SQL editor or CLI
```

> The list above is abbreviated — apply **every** file in `supabase/migrations/` in numeric order.
> **Migration `064_auth_rls_independent_pass_fixes.sql` must be applied BEFORE deploying the matching
> app build.** `middleware.ts` now reads its onboarding / MFA-enrolment state from the
> `middleware_gate_state()` function that migration creates; until it exists every page request
> answers 503 (deliberately fail-closed). 064 also normalises any non-boolean permission values already
> stored (to `false`), adds CHECK constraints on `roles.permissions` / `workspace_members.permission_overrides`,
> installs the password-change audit trigger on `auth.users`, and creates `auth_attempts`.

> **Migration `068_auth_rls_audit_round2.sql` must be applied BEFORE deploying the matching app build.**
> The app now calls functions it creates: `auth_attempt_begin` / `auth_attempt_release` (atomic sign-in and
> MFA attempt ledger), `issue_backup_codes` (backup-code enrolment — without it, finishing MFA setup fails),
> `user_has_password`, `list_user_sessions` / `revoke_user_session(s)`, and the `step_up_grants` /
> `session_seen` tables. It also restores two `leave_workspace_atomic` guards that 065 dropped (sole
> MANAGE_ROLES holder; trial creator), removes the stale `EXPORT_DATA` permission key, adds a CHECK on
> `users.name`, revokes leftover API-role grants, and installs sign-in audit triggers on `auth.sessions`.
> The two Auth hooks in §1.3 need Supabase's **Team or Enterprise** plan, so they can't be enabled on Free/Pro.
> The migration still creates their functions (harmless until enabled); until you're on that plan, the MFA /
> password lockout only covers calls made through the app's own routes — see §1.3 for what that leaves open.

**Required checks after migration:**
- [ ] `handle_new_user` trigger exists with SECURITY DEFINER
- [ ] Verify: `SELECT count(*) FROM auth.users` = `SELECT count(*) FROM public.users`
- [ ] Both `effectivePermissions` triggers exist and work (BUG-045):
  - `trg_member_effective_permissions` on `workspace_members`
  - `trg_role_permissions_propagate` on `roles`
- [ ] Test trigger B: update a role's permissions → check workspace_members.effective_permissions updated
- [ ] pgvector extension enabled: `SELECT * FROM pg_extension WHERE extname = 'vector'`
- [ ] All indexes from migration created
- [ ] RLS enabled on all tables

### 1.2 Storage Buckets (created by migration 068 if missing; the rest is manual)
> Migration 068 creates `logos` (public) and `flag-evidence` (private) if they don't exist, and always sets
> their **size and mime-type limits** (`logos`: 2 MB, PNG/JPEG; `flag-evidence`: 10 MB, the attachment types
> the upload route allows). Do the policy review below by hand — no storage policy is created for you.

Create in Supabase Dashboard → Storage:

1. **`logos`** — Public bucket (also holds profile avatars)
   - Toggle: Public ON (public bucket = objects are readable at their public URL; **no SELECT policy needed**)
   - **Do NOT add any INSERT / UPDATE policy for `authenticated`.** Logos and avatars are uploaded ONLY by
     `app/api/workspace/branding/logo/route.ts` and `app/api/workspace/profile/avatar/route.ts` through the
     service client, which validate type, size and (for SVG) refuse script-capable content. An INSERT policy
     lets any signed-in user call the Storage API directly and host arbitrary files — including live-script
     SVGs — on your public storage origin, bypassing every check in those routes.
   - If an earlier version of this README had you create them, remove them:
   ```sql
   DROP POLICY IF EXISTS "Users can upload their own logo" ON storage.objects;
   DROP POLICY IF EXISTS "Users can update their own logo" ON storage.objects;
   -- (the old public SELECT policy is harmless but unnecessary on a public bucket)
   ```

2. **`pdfs`** — Private bucket
   - Toggle: Public OFF
   - Service role only (no client-side access)

3. **`flag-evidence`** — Private bucket (Phase 2 — Portfolio dashboard addendum)
   - Toggle: Public OFF
   - Service role only — `app/api/scope-governance/[entityType]/[entityId]/attachments/route.ts`
     uploads via the service client and hands back short-lived signed URLs
     (1 hour) rather than public ones. No client-side storage policies
     needed, same as `pdfs`.
   - Stores evidence attached to Guardian flags/exceptions (screenshots,
     signed addenda). 10 MB per file, PDF/PNG/JPEG/WEBP/EML/TXT/DOCX only.

### 1.3 Auth Configuration
- [ ] **Custom SMTP:** Settings → Auth → SMTP → configure with Resend
  - Host: `smtp.resend.com`, Port: 465, User: `resend`, Pass: your Resend API key
  - From: `noreply@mail.scopegov.app`
- [ ] **Email templates:** Customize confirm signup, reset password (Settings → Auth → Email Templates).
  For links that also work when opened on a different device than the one that requested them (the default
  PKCE `?code=` links only work in the requesting browser), use the token-hash form:
  - Confirm signup: `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=signup&next=/onboarding`
  - Reset password: `{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery`
- [ ] **Confirm email: ON** (Auth → Sign In / Providers → Email). Sign-up sends people to "check your email".
- [ ] **Minimum password length ≥ 8** (Auth → Sign In / Providers → Email). Sign-up talks to Supabase Auth
  directly from the browser, so THIS setting — not the form — is the server-side rule for new accounts.
  (`/api/auth/change-password` and `/api/auth/reset-password` enforce 8 characters / 72 bytes themselves.)
- [ ] **Secure password change: ON** (and "require current password" where your plan offers it). Without it,
  any signed-in browser can call `supabase.auth.updateUser({ password })` directly and skip the current-password,
  recent-sign-in and MFA checks in `/api/auth/change-password`. (The database trigger from migration 064 still
  audits such a change, but it cannot prevent it.)
- [ ] **Auth Hooks — REQUIRE THE SUPABASE TEAM OR ENTERPRISE PLAN** (Auth → Hooks → Add hook; the dashboard
  greys both out on Free/Pro with "Team or Enterprise Plan required"). **Do this the day you upgrade**; until
  then skip both. Migration 068 already created the functions, so enabling them later needs no new migration.
  - *MFA verification attempt* → Postgres function `public.hook_mfa_verification_attempt`. **This is what makes
    the authenticator-code lockout impossible to bypass.** The app's own throttle (atomic, in
    `lib/auth/attempt-limit.ts`) only sees calls made through `/api/auth/mfa/*`; a password-only session can
    call Supabase Auth's MFA endpoints directly with the public anon key and guess codes without touching the
    app. The hook runs INSIDE Auth: 5 wrong codes in 5 minutes locks that account's verification (even for a
    correct code) and writes a `security.mfa_locked` audit row. (Trade-off: someone who already has the
    password can keep a victim locked out of the second-factor step; they still cannot get in.)
  - *Password verification attempt* → `public.hook_password_verification_attempt`. Audits every failed sign-in
    (`security.login_failed`) and locks password sign-in for an account after 10 failures in 10 minutes.
  - **Until then:** the in-app lockout still protects every attempt made through the app, and sign-ins are still
    audited server-side (trigger below, works on every plan). What stays open on a lower plan: someone who
    already holds a victim's password can guess authenticator codes by calling Supabase Auth directly, limited
    only by Supabase's own rate limits — review **Auth → Rate Limits** and keep the verification limits tight —
    and failed sign-in attempts are not audited. Both are worth closing before you have customers with
    sensitive data.
- [ ] **Sign-in audit trigger:** migration 068 creates `on_auth_session_created` /
  `on_auth_session_aal_upgraded` on `auth.sessions`, so every sign-in is audited server-side (previously only
  sign-ins the browser chose to report were). Confirm they exist:
  `SELECT tgname FROM pg_trigger WHERE tgrelid = 'auth.sessions'::regclass AND NOT tgisinternal;`
  If the migration printed a WARNING that it couldn't create them, re-run that section as a role that owns
  `auth.sessions`; the app-side login-event fallback covers you meanwhile.
- [ ] **Secure email change: ON** (Auth → Sign In / Providers → Email). Both the old and the new address must
  confirm. Settings → Account → "Sign-in email" uses it (`/api/auth/change-email`), and a signed-in browser can
  call `updateUser({ email })` directly, so this toggle is the server-side rule.
- [ ] **Leaked password protection: ON** where your plan offers it (Auth → Sign In / Providers → Email →
  *Prevent use of leaked passwords*). The app itself only rejects a short list of very common passwords.
- [ ] **Multi-factor (TOTP): enabled** (Auth → Multi Factor). Required for two-factor sign-in and for the
  mandatory-MFA policy on governance roles.
- [ ] **JWT expiry:** leave at the default (3600 s). Session cookies are re-issued on refresh; shortening it
  increases refresh traffic, lengthening it lengthens how long a revoked session's access token stays valid.
- [ ] **Google OAuth:** Enable in Settings → Auth → Providers → Google
  - Set redirect URL: `https://app.scopegov.app/api/auth/callback`
- [ ] **Site URL:** Settings → Auth → URL Configuration → `https://app.scopegov.app`
- [ ] **Redirect URLs:** Add `https://app.scopegov.app/**` and `https://sign.scopegov.app/**`

---

## 2. Vercel Setup

### 2.1 Environment Variables
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=           ← CRITICAL (BUG-033)
NEXT_PUBLIC_APP_URL=https://app.scopegov.app
NEXT_PUBLIC_COOKIE_DOMAIN=.scopegov.app      ← optional: share the PKCE code-verifier cookie across app./www. hosts
NEXT_PUBLIC_PORTAL_URL=https://sign.scopegov.app
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
OPENAI_API_KEY=                      ← for embeddings
RESEND_API_KEY=
RESEND_FROM_EMAIL=noreply@mail.scopegov.app
RESEND_WEBHOOK_SECRET=               ← whsec_… signing secret for POST /api/webhooks/resend (bounce/complaint tracking)
POSTMARK_INBOUND_WEBHOOK_SECRET=     ← Basic Auth password, see §4 (NOT an HMAC secret)
NEXT_PUBLIC_GUARDIAN_EMAIL_DOMAIN=guard.scopegov.app
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=
PAYSTACK_SECRET_KEY=
PAYSTACK_PLAN_SOLO_MONTHLY=
PAYSTACK_PLAN_STARTER_MONTHLY=
PAYSTACK_PLAN_PRO_MONTHLY=
PAYSTACK_PLAN_AGENCY_MONTHLY=
PAYSTACK_PLAN_SOLO_ANNUAL=
PAYSTACK_PLAN_STARTER_ANNUAL=
PAYSTACK_PLAN_PRO_ANNUAL=
PAYSTACK_PLAN_AGENCY_ANNUAL=
CRON_SECRET=                         ← openssl rand -hex 32 (BUG-036)
MFA_BACKUP_CODE_PEPPER=              ← openssl rand -hex 32. Server-only key for the HMAC that stores MFA backup
                                       codes (a leaked database alone no longer yields usable codes). Codes issued
                                       before it was set keep working. DO NOT ROTATE casually: changing it
                                       invalidates every backup code issued under the old value (people can
                                       regenerate them in Settings). If unset, codes fall back to an unsalted SHA-256.
```

### 2.2 Domains
- `app.scopegov.app` → main app
- `sign.scopegov.app` → client portal (same Vercel deployment, different domain)

---

## 3. DNS Configuration

### 3.1 MX Record for Guardian inbound (BUG-035)
```
Type: MX
Name: guard (or guard.scopegov.app)
Value: inbound.postmarkapp.com
Priority: 10
TTL: 3600
```

### 3.2 Email authentication
```
# SPF (for mail.scopegov.app)
Type: TXT
Name: mail
Value: v=spf1 include:spf.resend.com ~all

# DKIM — get values from Resend dashboard
Type: TXT
Name: resend._domainkey.mail
Value: [from Resend]

# DMARC
Type: TXT
Name: _dmarc
Value: v=DMARC1; p=quarantine; rua=mailto:dmarc@scopegov.app
```

---

## 4. Postmark Setup

**Postmark does not sign inbound webhooks with HMAC** — there is no "webhook
secret" field to copy from its dashboard. Postmark's own recommended
protection is HTTP Basic Auth (credentials embedded directly in the webhook
URL) plus IP allowlisting. This app checks Basic Auth on every inbound
request — set it up as follows:

- [ ] Generate a secret: `openssl rand -hex 32` → set as `POSTMARK_INBOUND_WEBHOOK_SECRET`
- [ ] Create inbound server in Postmark
- [ ] Set inbound webhook URL to: `https://postmark:<POSTMARK_INBOUND_WEBHOOK_SECRET>@app.scopegov.app/api/guardian/inbound`
      (the username can be anything — `postmark` is just a convention; the
      part after the colon must exactly match the env var above)
- [ ] MX record configured (step 3.1)
- [ ] Optional, defense-in-depth: allowlist Postmark's published webhook IPs
      (see postmarkapp.com/support/article/800-ips-for-firewalls) at your
      firewall/CDN layer — Postmark's own guidance is to combine this with
      Basic Auth, not to rely on either alone
- [ ] Verify by sending a real email to `proj-test1234@guard.scopegov.app` and
      confirming it lands as a `guardian_checks` row, not a 401 in the logs —
      a curl test against the URL with correct credentials only proves the
      auth check works, not that Postmark itself is configured to send them

---

## 5. Paystack Setup
- [ ] Add webhook URL: `https://app.scopegov.app/api/billing/webhook`
- [ ] Ensure all events enabled: `subscription.create`, `charge.success`, `subscription.disable`, `invoice.payment_failed`
- [ ] Get all plan codes and add to env vars
- [ ] Use live keys in production (not test)
- [ ] Disable customer email notifications (Settings → Notifications) — ScopeGov handles emails

---

## 6. Code Checks (before first commit)

Per Bug Catalogue — verify these before deploying:

- [ ] `(supabase as any).from(...)` on EVERY query — reads AND writes (BUG-039)
- [ ] Every file with JSX is `.tsx` (BUG-043)
- [ ] `export const runtime = 'nodejs'` is LINE 1 in PDF/AI routes (BUG-037)
- [ ] No `export const runtime` in any client component (BUG-037)
- [ ] `stripAndParse()` applied to every Claude API response (BUG-027)
- [ ] `isAttentionWorthy` uses status checks only — no standalone `escalatedTo IS NOT NULL` (BUG-051)
- [ ] `effectiveContractValue` excludes `exceptions_log` (BUG-053)
- [ ] CO stall job: `awaiting_response` only, NOT `countered` (BUG-055)
- [ ] Flag reversion fires on decline, close, AND withdraw (BUG-048)
- [ ] `acceptedAt` set unconditionally on all acceptance paths (BUG-047)
- [ ] `jwtSecret` lives ONLY in `workspace_secrets` (RLS deny-all, service_role only) — never re-add it as a column on `workspaces` itself, even with "exclude from API responses" discipline in app code. RLS is row-level, not column-level: a column on `workspaces` is readable by any active member directly via Supabase's REST API regardless of what the Next.js routes return (BUG-062 / migration 013)
- [ ] `stallReason` cleared by state machine on Stalled→Active (BUG-046)
- [ ] Amendment handler queries highest-versioned signed SOW (BUG-052)
- [ ] Embedding computed for all submissions, persisted only for non-duplicates (BUG-060)
- [ ] `VIEW_OWN_PROJECTS` vs `VIEW_ALL_PROJECTS` are distinct query paths (BUG-058)
- [ ] Onboarding page at `app/onboarding/` — OUTSIDE `(app)/` group (BUG-001)
- [ ] Portfolio dashboard (`/portfolio`) is gated on `VIEW_ALL_PROJECTS` server-side (page) AND in the API route — never trust the sidebar link being hidden as the actual gate
- [ ] `scope_health_snapshots` upsert uses `onConflict: 'workspace_id,snapshot_date'` — safe to re-run the rollup cron the same day without duplicating rows
- [ ] `flag_comments`/`flag_attachments` `entity_type` is validated against `isValidEntityType` before every DB read/write — never interpolated from the URL unchecked
- [ ] `contract_value_at_risk` is single-currency per snapshot (resolved the same way `/api/reports` picks a currency) — never summed across currencies
- [ ] Project Discussion (`project_messages`) has no permission gate of its own — access is `canReadProject` (lib/utils/project-access.ts), same check the project page itself uses. Don't add a permission check here without also asking whether that's the right call for `/api/projects/[id]/page.tsx`.
- [ ] `@[Name](id)` mention tokens are re-derived from the message body server-side on both create and edit — never trust a client-supplied mention id list (see lib/utils/project-messages.ts)
- [ ] A deleted `project_messages` row is a soft delete (`deleted_at`) — the API never returns its `body` to clients, but the row stays for `project_message_mentions` and `audit_log` to keep pointing at something real

---

## 7. Smoke Tests (after every deploy)

- [ ] Sign up → email arrives → verify → reach dashboard
- [ ] Google OAuth → reach onboarding → complete → reach dashboard
- [ ] Create project → SOW generates
- [ ] Send SOW → client email arrives with portal link
- [ ] Client signs → agency email arrives + guardian address set
- [ ] Forward test email to guardian address → verdict stored in Guardian tab
- [ ] Paste email in Guardian → classification fires
- [ ] Create CO → send → client portal loads correctly
- [ ] Open a project's Discussion tab → post a message → @mention a teammate (autocomplete should appear after typing `@`) → mentioned teammate sees a notification and it deep-links to the Discussion tab → edit and delete your own message
- [ ] Client accepts CO → amendment created, acceptedAt populated
- [ ] Client declines CO with linked flag → flag reverts to open
- [ ] Client counters CO → agency can accept counter
- [ ] Logo upload works (proves storage RLS is correct)
- [ ] Payment flow (test mode) → plan updates ONLY on webhook
- [ ] Trial warning email fires (manual trigger)
- [ ] Invite email → new user → accept → workspace member active
- [ ] Invite email → existing user → sign in → accept
- [ ] Trigger `POST /api/cron/scope-health-rollup` manually (with `CRON_SECRET`) → `scope_health_snapshots` row appears for today
- [ ] Visit `/portfolio` as a VIEW_ALL_PROJECTS holder → metrics, trend chart, and drill-down tables render
- [ ] Visit `/portfolio` as a member without VIEW_ALL_PROJECTS → sees the permission-required message, not the dashboard, and the sidebar link is hidden
- [ ] Open a Guardian flag → "Notes & evidence" → post a comment as an APPROVE_FLAGS holder → appears immediately, flag owner gets a notification
- [ ] Upload a file under "Notes & evidence" → appears in the list with a working signed download link

---

## 8. Architecture Notes

### Route groups
```
app/
  (auth)/          ← login, signup, forgot-password, reset-password
  (app)/           ← protected: dashboard, projects, clients, team, sow, reports, settings
  onboarding/      ← OUTSIDE (app) — prevents redirect loop (BUG-001)
  portal/          ← client-facing SOW + CO portals (no auth)
  invite/[token]/  ← invite acceptance (both new and existing users)
  api/             ← all API routes
```

### Authentication
- Two JWT families (spec §0.4):
  1. Supabase session JWT — for authenticated app users
  2. Document JWT (HS256, workspace-specific secret) — for unauthenticated client portals
- `jwtSecret` isolated in its own `workspace_secrets` table (RLS deny-all, service_role only) — not just excluded from API responses. A column on `workspaces` itself would be readable by any active member directly via Supabase's REST API regardless of what our own routes return, since RLS is row-level, not column-level (BUG-062 / migration 013)
- Middleware refreshes session on every request

### Background jobs (Vercel Cron)
All 15 jobs from spec §1.13 are scheduled in `vercel.json`.
All require `Authorization: Bearer {CRON_SECRET}` header.

### Guardian pipeline
1. Embedding computed (always — BUG-060)
2. Dedup check (cosine similarity > 0.85)
3. If duplicate: write row with `isDuplicate=true`, skip classification
4. If not duplicate: classify → determine outcome
5. If `out_of_scope`: create flag, notify APPROVE_FLAGS holders
6. All thresholds from workspace settings (BUG-061)

### Portfolio dashboard (Phase 2)
1. `scope-health-rollup` cron runs daily (05:30 UTC, right after the
   05:00 UTC reconciliation rollup), one snapshot row per workspace in
   `scope_health_snapshots` (schema: `007_scope_health.sql`) — upserted
   on `(workspace_id, snapshot_date)`, so re-running it the same day is
   safe.
2. `contract_value_at_risk` is a severity-weighted estimate, not a real
   ledger figure: open flags borrow a slice of their project's contract
   value (`OPEN_FLAG_RISK_RATE`, currently 5%), exceptions_log entries
   contribute their real `estimated_value`. Both are weighted by severity
   (`high=1.0 / medium=0.5 / low=0.2`) — see comments in
   `app/api/cron/scope-health-rollup/route.ts` for the exact formula. The
   multiplier values are a tuning knob, not a schema decision.
3. `/portfolio` (gated on `VIEW_ALL_PROJECTS`) reads snapshots for the
   trend chart and live tables (`guardian_flags`, stalled `projects`/
   `change_orders`) for drill-down, via `GET /api/reports/portfolio`.
4. The governance-scoped collaboration addendum — `flag_comments` and
   `flag_attachments`, scoped only to `guardian_flags`/`exceptions_log` —
   lives under `app/api/scope-governance/[entityType]/[entityId]/` and is
   surfaced in the Guardian tab via `FlagCollaboration.tsx`. Writing
   requires `APPROVE_FLAGS` or `GRANT_EXCEPTIONS`; reading follows the
   same project-visibility rule as the flag itself.
