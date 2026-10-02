import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Onboarding independent pass 11.
//   B1  GET /api/team/roles answered an empty 200 when the roles read failed, so the wizard hid its role
//       picker and the invite went out with no roleId (invitee silently got the default role).
//   B2  .ob-card had no narrow-screen rule (40px/44px padding left ~222px of content at 360px).

let rolesResult: any = { data: [], error: null }

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', workspaceId: 'w1', permissions: {} }),
  hasPermission: () => false,
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {} }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, order: async () => rolesResult }
      return q
    },
  }),
}))
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('B1 roles list fails closed', () => {
  beforeEach(() => { rolesResult = { data: [], error: null } })

  it('answers 500, not an empty 200 list, when the roles read fails', async () => {
    rolesResult = { data: null, error: { message: 'boom' } }
    const { GET } = await import('@/app/api/team/roles/route')
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).roles).toBeUndefined()
  })

  it('still returns the redacted list on success', async () => {
    rolesResult = { data: [{ id: 'r1', name: 'Admin', description: null, permissions: { X: true }, is_default: true }], error: null }
    const { GET } = await import('@/app/api/team/roles/route')
    const json = await (await GET()).json()
    expect(json.roles).toEqual([{ id: 'r1', name: 'Admin', description: null, is_default: true }])
  })

  const page = read('app/onboarding/page.tsx')
  it('the wizard treats a non-ok or malformed response as a failure and offers Retry', () => {
    expect(page).toMatch(/if \(!r\.ok \|\| !Array\.isArray\(json\.roles\)\) throw/)
    expect(page).toMatch(/setRolesAttempt\(n => n \+ 1\)/)
  })
  it('submitInvite refuses to send while the role list is not loaded', () => {
    const fn = page.slice(page.indexOf('async function submitInvite'))
    expect(fn.indexOf('inviteRoles.length === 0')).toBeGreaterThan(-1)
    expect(fn.indexOf('inviteRoles.length === 0')).toBeLessThan(fn.indexOf("fetch('/api/team/invite'"))
  })
})

describe('B2 narrow-screen onboarding card', () => {
  it('shrinks the card padding and lets the nav row wrap on phones', () => {
    const css = read('styles/globals.css')
    expect(css).toMatch(/@media \(max-width: 480px\) \{[^}]*\.ob-root \{ padding: 16px 12px; \}[\s\S]*?\.ob-card \{ padding: 28px 20px; \}[\s\S]*?\.ob-nav \{ flex-wrap: wrap;/)
  })
})
