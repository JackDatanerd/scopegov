// Admin panel independent audit, round 2 — regression guards (B1–B6).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const read = (p: string) => readFileSync(p, 'utf8')
const code = (p: string) => read(p).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('B1 — platform staff IP never lands in a customer-visible audit row', () => {
  for (const f of [
    'app/api/admin/users/[id]/reset-mfa/route.ts',
    'app/api/admin/users/[id]/revoke-sessions/route.ts',
    'app/api/admin/workspaces/[id]/change-plan/route.ts',
  ]) {
    it(`${f} passes omitClientIp to logAudit`, () => {
      const src = code(f)
      expect(src).toContain('logAudit(')
      expect(src).toContain('omitClientIp: true')
    })
  }
})

describe('B2 — platform MFA reset e-mail is attributed to ScopeGov support', () => {
  it('the route uses the platform_support variant and the template has it', () => {
    expect(code('app/api/admin/users/[id]/reset-mfa/route.ts')).toContain("via: 'platform_support'")
    const t = read('lib/email/templates.ts')
    expect(t).toContain("'platform_support'")
    expect(t).toContain('The ScopeGov support team just reset')
  })
})

describe('B3 — erase_user_pii reaches platform_admin_audit_log', () => {
  const sql = read('supabase/migrations/143_erase_user_pii_admin_audit.sql')
  it('scrubs target_label by user id and by typed e-mail, and backfills erased accounts', () => {
    expect(sql).toMatch(/UPDATE public\.platform_admin_audit_log/)
    expect(sql).toContain("target_type = 'user' AND target_id = p_user_id")
    expect(sql).toContain('lower(btrim(target_label)) = lower(btrim(p_email))')
    expect(sql).toContain("u.email LIKE 'deleted-%@deleted.scopegov.app'")
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.erase_user_pii/)
  })
})

describe('B4 — overview stuck counts ignore suspended / deleted workspaces', () => {
  it('both queries join workspaces and filter deleted_at', () => {
    const src = code('app/(admin)/admin/page.tsx')
    expect((src.match(/workspaces!inner\(deleted_at\)/g) || []).length).toBe(2)
    expect((src.match(/is\('workspaces\.deleted_at', null\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('B5/B6 — mutating admin routes validate input and surface read failures', () => {
  it('workspace suspend only trims a string reason', () => {
    expect(code('app/api/admin/workspaces/[id]/suspend/route.ts')).toContain("typeof body.reason === 'string'")
  })
  for (const f of [
    'app/api/admin/users/[id]/suspend/route.ts', 'app/api/admin/users/[id]/restore/route.ts',
    'app/api/admin/users/[id]/reset-mfa/route.ts', 'app/api/admin/users/[id]/revoke-sessions/route.ts',
    'app/api/admin/workspaces/[id]/suspend/route.ts', 'app/api/admin/workspaces/[id]/restore/route.ts',
    'app/api/admin/workspaces/[id]/change-plan/route.ts', 'app/api/admin/workspaces/[id]/extend-trial/route.ts',
  ]) {
    it(`${f} answers 500 (not 404) when the lookup itself fails`, () => {
      const src = code(f)
      expect(src).toMatch(/const \{ data: (target|workspace), error: \w+ \}/)
      expect(src).toMatch(/Could not load this (user|workspace)/)
    })
  }
})
