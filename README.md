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
# Run the migration in order:
# supabase/migrations/001_initial_schema.sql
# Execute via Supabase SQL editor or CLI
```

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

### 1.2 Storage Buckets (MANUAL — not in migrations)
Create in Supabase Dashboard → Storage:

1. **`logos`** — Public bucket
   - Toggle: Public ON
   - Add RLS policies (from `001_initial_schema.sql` comments):
   ```sql
   CREATE POLICY "Users can upload their own logo" ON storage.objects
     FOR INSERT TO authenticated
     WITH CHECK (bucket_id = 'logos' AND auth.uid()::text = (storage.foldername(name))[1]);

   CREATE POLICY "Users can update their own logo" ON storage.objects
     FOR UPDATE TO authenticated
     USING (bucket_id = 'logos' AND auth.uid()::text = (storage.foldername(name))[1]);

   CREATE POLICY "Public can read logos" ON storage.objects
     FOR SELECT TO public USING (bucket_id = 'logos');
   ```

2. **`pdfs`** — Private bucket
   - Toggle: Public OFF
   - Service role only (no client-side access)

### 1.3 Auth Configuration
- [ ] **Custom SMTP:** Settings → Auth → SMTP → configure with Resend
  - Host: `smtp.resend.com`, Port: 465, User: `resend`, Pass: your Resend API key
  - From: `noreply@mail.scopegov.app`
- [ ] **Email templates:** Customize confirm signup, reset password (Settings → Auth → Email Templates)
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
NEXT_PUBLIC_PORTAL_URL=https://sign.scopegov.app
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
OPENAI_API_KEY=                      ← for embeddings
RESEND_API_KEY=
RESEND_FROM_EMAIL=noreply@mail.scopegov.app
RESEND_FROM_NAME=ScopeGov
POSTMARK_INBOUND_WEBHOOK_SECRET=
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
- [ ] Create inbound server in Postmark
- [ ] Set inbound webhook URL: `https://app.scopegov.app/api/guardian/inbound`
- [ ] Copy the webhook secret → `POSTMARK_INBOUND_WEBHOOK_SECRET`
- [ ] MX record configured (step 3.1)
- [ ] Verify by sending a test email to `proj-test1234@guard.scopegov.app`

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
- [ ] `jwtSecret` excluded from all API responses (BUG-062)
- [ ] `stallReason` cleared by state machine on Stalled→Active (BUG-046)
- [ ] Amendment handler queries highest-versioned signed SOW (BUG-052)
- [ ] Embedding computed for all submissions, persisted only for non-duplicates (BUG-060)
- [ ] `VIEW_OWN_PROJECTS` vs `VIEW_ALL_PROJECTS` are distinct query paths (BUG-058)
- [ ] Onboarding page at `app/onboarding/` — OUTSIDE `(app)/` group (BUG-001)

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
- [ ] Client accepts CO → amendment created, acceptedAt populated
- [ ] Client declines CO with linked flag → flag reverts to open
- [ ] Client counters CO → agency can accept counter
- [ ] Logo upload works (proves storage RLS is correct)
- [ ] Payment flow (test mode) → plan updates ONLY on webhook
- [ ] Trial warning email fires (manual trigger)
- [ ] Invite email → new user → accept → workspace member active
- [ ] Invite email → existing user → sign in → accept

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
- `jwtSecret` never in any API response (BUG-062)
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
