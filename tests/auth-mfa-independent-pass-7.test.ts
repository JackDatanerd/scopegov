import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Regression coverage for the Auth + MFA independent pass 7:
//  B1  a platform admin with NO workspace can reach /mfa-setup and is sent there from /admin
//  B2  /api/auth/mfa/verify: once the factor is verified, a failure issuing backup codes (or a
//      lookup throwing) must not skip the audit row / notice / email / sign-out-of-others
//  B3  migration 131: an aal1 -> aal2 upgrade of a session whose sign-in was already recorded
//      (first MFA enrolment) is not recorded as a second sign-in

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

let user: any
let factors: { totp: any[]; all: any[] }
let issueBehaviour: 'ok' | 'throw'
let workspaceBehaviour: 'ok' | 'throw'
let nameBehaviour: 'ok' | 'throw'
let adminRow: any
let calls: { audit: number; notify: number; email: number; signOutOthers: number; auditArgs: any[] }

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: adminRow }) }) }) }),
  }),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user } }),
      getSession: async () => ({ data: { session: null } }),
      signOut: async (opts?: any) => { if (opts?.scope === 'others') calls.signOutOthers++; return { error: null } },
      mfa: {
        listFactors: async () => ({ data: factors, error: null }),
        challengeAndVerify: async () => ({ error: null }),
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } }),
      },
    },
  }),
}))
vi.mock('@/lib/auth/attempt-limit', () => ({
  AUTH_ATTEMPT_LIMIT: { maxFailures: 5, windowSeconds: 300 },
  beginAuthAttempt: async () => ({ allowed: true, retryAfterSeconds: 0, failures: 1, attemptId: 'a1' }),
  releaseAuthAttempt: async () => {},
  clearAuthFailures: async () => {},
  lockedResponseBody: () => ({}),
}))
vi.mock('@/lib/auth/session', () => ({
  resolveActorName: async (_s: any, _u: any, f: string) => { if (nameBehaviour === 'throw') throw new Error('db down'); return f },
  resolveActiveWorkspaceId: async () => { if (workspaceBehaviour === 'throw') throw new Error('db down'); return 'w1' },
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/notify', () => ({ notifySecurityEvent: async () => { calls.notify++ } }))
vi.mock('@/lib/auth/backup-code-store', () => ({
  issueBackupCodes: async () => { if (issueBehaviour === 'throw') throw new Error('rpc failed'); return ['AAAAAA-BBBBBB', 'CCCCCC-DDDDDD'] },
}))
vi.mock('@/lib/auth/security-audit', () => ({
  logSecurityAudit: async (_s: any, p: any) => { calls.audit++; calls.auditArgs.push(p) },
}))
vi.mock('@/lib/auth/login-audit', () => ({ logLoginOnce: async () => true }))
vi.mock('@/lib/email/templates', () => ({
  sendAccountLockedEmail: async () => ({}),
  sendMfaEnabledEmail: async () => { calls.email++; return {} },
}))

beforeEach(() => {
  user = { id: 'u1', email: 'a@b.co', user_metadata: {}, factors: [] }
  factors = { totp: [], all: [{ id: 'f1', status: 'unverified', factor_type: 'totp' }] }
  issueBehaviour = 'ok'; workspaceBehaviour = 'ok'; nameBehaviour = 'ok'
  adminRow = null
  calls = { audit: 0, notify: 0, email: 0, signOutOthers: 0, auditArgs: [] }
})

// ── B2 ───────────────────────────────────────────────────────────────────
describe('B2: POST /api/auth/mfa/verify — first enrolment completes even if a follow-up step fails', () => {
  const post = async (body: any = { factorId: 'f1', code: '123456' }) =>
    (await import('../app/api/auth/mfa/verify/route')).POST(new NextRequest('http://localhost/api/auth/mfa/verify', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }))

  it('happy path returns the backup codes and runs every follow-up', async () => {
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.backupCodes).toEqual(['AAAAAA-BBBBBB', 'CCCCCC-DDDDDD'])
    expect(json.backupCodesIssued).toBe(true)
    expect([calls.audit, calls.notify, calls.email, calls.signOutOthers]).toEqual([1, 1, 1, 1])
  })

  it('a failure issuing backup codes is NOT a failed enrolment: 200, no codes, audit/notice/email/sign-out-others all still run', async () => {
    issueBehaviour = 'throw'
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.backupCodes).toEqual([])
    expect(json.backupCodesIssued).toBe(false)
    expect(calls.auditArgs[0].eventType).toBe('security.mfa_enabled')
    expect([calls.audit, calls.notify, calls.email, calls.signOutOthers]).toEqual([1, 1, 1, 1])
  })

  it('a throwing workspace / name lookup after the factor is verified does not turn into a 500', async () => {
    workspaceBehaviour = 'throw'; nameBehaviour = 'throw'
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(calls.audit).toBe(1)
    expect(calls.auditArgs[0].actorName).toBe('a@b.co')
    expect(calls.auditArgs[0].fallbackWorkspaceId).toBeNull()
  })

  it('an ordinary sign-in challenge (factor already verified) is unchanged: { ok: true }, no enrolment side effects', async () => {
    factors = { totp: [{ id: 'f1', status: 'verified' }], all: [{ id: 'f1', status: 'verified', factor_type: 'totp' }] }
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect([calls.audit, calls.notify, calls.email, calls.signOutOthers]).toEqual([0, 0, 0, 0])
  })

  it('the client still treats an empty code list as "show the Generate button", never as an error', () => {
    const src = read('components/mfa/MfaSetupClient.tsx')
    expect(src).toContain('if (json.backupCodes && json.backupCodes.length > 0) setBackupCodes(json.backupCodes)')
    expect(src).toContain('Generate backup codes')
  })
})

// ── B1 ───────────────────────────────────────────────────────────────────
describe('B1: adminNeedsMfaEnrolment()', () => {
  const run = async () => (await import('../lib/auth/admin')).adminNeedsMfaEnrolment()

  it('is { name } for a signed-in platform admin with no verified factor', async () => {
    adminRow = { name: 'Support Sam', email: 's@x.co', is_platform_admin: true, deleted_at: null }
    expect(await run()).toEqual({ name: 'Support Sam' })
  })

  it('falls back to the email, then a neutral word, when the admin has no display name', async () => {
    adminRow = { name: '', email: 's@x.co', is_platform_admin: true, deleted_at: null }
    expect(await run()).toEqual({ name: 's@x.co' })
    adminRow = { name: '', email: '', is_platform_admin: true, deleted_at: null }
    expect(await run()).toEqual({ name: 'there' })
  })

  it('is null for everyone who is not exactly that person (so a non-admin learns nothing)', async () => {
    adminRow = { name: 'N', email: 'n@x.co', is_platform_admin: false, deleted_at: null }
    expect(await run()).toBeNull()                                   // ordinary user
    adminRow = { name: 'D', email: 'd@x.co', is_platform_admin: true, deleted_at: '2026-01-01' }
    expect(await run()).toBeNull()                                   // deleted admin
    adminRow = null
    expect(await run()).toBeNull()                                   // no public.users row
    adminRow = { name: 'S', email: 's@x.co', is_platform_admin: true, deleted_at: null }
    user = { ...user, factors: [{ status: 'verified' }] }
    expect(await run()).toBeNull()                                   // already enrolled: nothing to do
    user = null
    expect(await run()).toBeNull()                                   // signed out
  })

  it('an unverified-only factor list still counts as "not enrolled"', async () => {
    adminRow = { name: 'S', email: 's@x.co', is_platform_admin: true, deleted_at: null }
    user = { ...user, factors: [{ status: 'unverified' }] }
    expect(await run()).toEqual({ name: 'S' })
  })

  it('the admin guard sends an un-enrolled admin to /mfa-setup, and keeps the silent /dashboard redirect for everyone else', () => {
    // Moved out of the layout into lib/admin/page-guard.ts (Admin panel audit — B1): a layout redirect does not protect
    // the pages' own data, so the same guard now runs in the layout AND at the top of every admin Server Component.
    const layout = read('app/(admin)/admin/layout.tsx')
    expect(layout).toContain("import { requireAdminPage } from '@/lib/admin/page-guard'")
    expect(layout).toContain('await requireAdminPage()')
    const src = read('lib/admin/page-guard.ts')
    expect(src).toContain("import { getAdminActor, adminNeedsMfaEnrolment, type AdminActor } from '@/lib/auth/admin'")
    const i = src.indexOf('const actor = await getAdminActor()')
    expect(i).toBeGreaterThan(-1)
    const block = src.slice(i)
    expect(block).toContain("if (await adminNeedsMfaEnrolment()) redirect('/mfa-setup?next=%2Fadmin')")
    expect(block.indexOf('adminNeedsMfaEnrolment')).toBeLessThan(block.indexOf("redirect('/dashboard')"))
  })

  it('/mfa-setup no longer requires a workspace session for such an admin, and defaults them to /admin', () => {
    const src = read('app/mfa-setup/page.tsx')
    expect(src).toContain('const adminPending = await adminNeedsMfaEnrolment()')
    expect(src).toContain("if (!session && !adminPending) redirect('/login')")
    expect(src).toContain("sp.next.startsWith('/admin') ? safeRedirectPath(sp.next) : '/admin'")
    // A signed-out / non-admin visitor is still bounced to /login — the old unconditional redirect is gone.
    expect(src).not.toMatch(/if \(!session\) redirect\('\/login'\)/)
    // Coming for the admin panel makes it non-skippable (otherwise Skip -> /admin -> back here).
    expect(src).toContain("(!!adminPending && next.startsWith('/admin'))")
  })

  it('middleware still lets the admin reach /admin and /mfa-setup without a workspace (the premise of the fix)', () => {
    const src = read('middleware.ts')
    expect(src).toContain('if (!isOnboarding && !isMfaFlowRoute && !isAdminRoute) {')
    expect(src).toContain("pathname.startsWith('/mfa-setup')")
  })
})

// ── B3 ───────────────────────────────────────────────────────────────────
describe('B3: migration 131 — one login row per session', () => {
  const sql = read('supabase/migrations/131_session_login_audit_once_per_session.sql')
  const upd = sql.slice(sql.indexOf('ELSE'), sql.indexOf('SELECT i.provider'))

  it('the UPDATE (aal upgrade) branch stands down when this session already has a login row', () => {
    expect(upd).toContain("a.event_type = 'security.login_succeeded'")
    expect(upd).toContain("a.metadata ->> 'session_id' = NEW.id::text")
    expect(upd).toContain('a.actor_id = NEW.user_id')
    // ...and only AFTER the aal1->aal2 transition test, so non-upgrades still return early first.
    expect(upd.indexOf("<> 'aal2'")).toBeLessThan(upd.indexOf('security.login_succeeded'))
  })

  it('does not touch the INSERT branch, the credential-check skip, or the grants from 115', () => {
    const prev = read('supabase/migrations/115_credential_check_sessions_not_logins.sql')
    for (const needle of [
      "LIKE 'ScopeGov-CredentialCheck/%'",
      'FROM auth.mfa_factors f WHERE f.user_id = NEW.user_id AND f.status = \'verified\'',
      "IF TG_OP = 'UPDATE' THEN v_meta := v_meta || jsonb_build_object('mfa', 'totp'); END IF;",
      "PERFORM public.security_audit_insert(NEW.user_id, 'security.login_succeeded', v_meta, false, v_row ->> 'ip');",
    ]) { expect(prev).toContain(needle); expect(sql).toContain(needle) }
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.audit_auth_session_login() FROM PUBLIC, anon, authenticated;')
    expect(sql).not.toMatch(/CREATE TRIGGER/)  // triggers from 068 keep pointing at the replaced function
  })

  it('keeps the metadata key the check relies on: the INSERT branch writes session_id', () => {
    expect(sql).toContain("jsonb_build_object('source', 'db_trigger', 'method', v_method, 'session_id', NEW.id,")
  })
})
