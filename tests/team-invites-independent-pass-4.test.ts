// tests/team-invites-independent-pass-4.test.ts
//
// Regression tests for Team & Invites independent pass 4:
//   B1 — role names / descriptions were only .trim()ed: zero-width + filler characters made visually identical
//        duplicate roles slip past the uniqueness check, and CR/LF reached email subjects
//   B2 — invite creation and Resend built the link from NEXT_PUBLIC_APP_URL with no guard ("undefined/invite/…")
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'fs'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any

function chain(table: string, ops: Op[] = []): any {
  return new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (res: any, rej: any) => {
          calls.push({ table, ops })
          return Promise.resolve(resolver(table, ops)).then(res, rej)
        }
      }
      return (...args: any[]) => chain(table, [...ops, { name: prop, args }])
    },
  })
}

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session, getSessionStrict: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (t: string) => chain(t), rpc: async () => ({ data: [], error: null }) }),
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'actor' } } }) } }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))

const read = (p: string) => readFileSync(p, 'utf8')
const has = (ops: Op[], name: string) => ops.some(o => o.name === name)
const post = (body: unknown) =>
  new NextRequest('http://localhost/api/team/roles', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/team/roles/r9', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

const ZWSP = '\u200B'
const HANGUL_FILLER = '\u3164'

beforeEach(() => {
  calls.length = 0
  resolver = () => ({ data: null, error: null })
  session = {
    id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'actor@x.com', agencyName: 'Acme',
    workspaceName: 'Acme', planTier: 'agency', permissions: ['MANAGE_ROLES'],
  }
})

describe('B1: role names are compared and stored on the sanitized form', () => {
  it('normalizeRoleName ignores zero-width and filler characters and case', async () => {
    const { normalizeRoleName, roleNameTaken } = await import('@/lib/utils/role-names')
    expect(normalizeRoleName(`Designer${ZWSP}`)).toBe('designer')
    expect(normalizeRoleName(`  Designer${HANGUL_FILLER} `)).toBe('designer')
    expect(roleNameTaken([{ id: 'r1', name: 'Account Manager' }], `account manager${ZWSP}`)).toBe(true)
    // a genuinely different name is still free, and a role never clashes with itself
    expect(roleNameTaken([{ id: 'r1', name: 'Account Manager' }], 'Account Lead')).toBe(false)
    expect(roleNameTaken([{ id: 'r1', name: 'Account Manager' }], `Account Manager${ZWSP}`, 'r1')).toBe(false)
  })

  it('POST /api/team/roles refuses an invisible-character duplicate of an existing role', async () => {
    resolver = (table, ops) => {
      if (table === 'roles' && !has(ops, 'insert')) return { data: [{ id: 'r1', name: 'Account Manager' }], error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/roles/route')
    const res = await POST(post({ name: `Account Manager${ZWSP}`, permissions: {} }))
    expect(res.status).toBe(409)
    expect(calls.some(c => c.table === 'roles' && has(c.ops, 'insert'))).toBe(false)
  })

  it('POST /api/team/roles stores a single-line, sanitized name and description', async () => {
    resolver = (table, ops) => {
      if (table === 'roles' && has(ops, 'insert')) return { data: { id: 'new1' }, error: null }
      if (table === 'roles') return { data: [], error: null }
      return { data: null, error: null }
    }
    const { POST } = await import('@/app/api/team/roles/route')
    const res = await POST(post({ name: 'Ops\r\nBcc: x', description: `Runs${ZWSP}\r\nops`, permissions: {} }))
    expect(res.status).toBe(200)
    const insert = calls.find(c => c.table === 'roles' && has(c.ops, 'insert'))!
    const row = insert.ops.find(o => o.name === 'insert')!.args[0]
    expect(row.name).toBe('Ops Bcc: x')
    expect(row.name).not.toMatch(/[\r\n]/)
    expect(row.description).toBe('Runs ops')
  })

  it('POST /api/team/roles rejects a name with nothing visible in it', async () => {
    const { POST } = await import('@/app/api/team/roles/route')
    const res = await POST(post({ name: `${ZWSP}${HANGUL_FILLER}  `, permissions: {} }))
    expect(res.status).toBe(400)
    expect(calls.some(c => c.table === 'roles' && has(c.ops, 'insert'))).toBe(false)
  })

  it('PATCH /api/team/roles/[id] refuses to rename onto an invisible-character duplicate', async () => {
    resolver = (table, ops) => {
      if (table !== 'roles') return { data: null, error: null }
      if (has(ops, 'maybeSingle')) return { data: { name: 'Account Manager', description: null, permissions: {}, is_default: false }, error: null }
      return { data: [{ id: 'r9', name: 'Account Manager' }, { id: 'r2', name: 'Designer' }], error: null }
    }
    const { PATCH } = await import('@/app/api/team/roles/[id]/route')
    const res = await PATCH(patch({ name: `Designer${ZWSP}` }), params('r9'))
    expect(res.status).toBe(409)
    expect(calls.some(c => c.table === 'roles' && has(c.ops, 'update'))).toBe(false)
  })

  it('PATCH /api/team/roles/[id] stores the sanitized name when renaming', async () => {
    resolver = (table, ops) => {
      if (table !== 'roles') return { data: null, error: null }
      if (has(ops, 'maybeSingle')) return { data: { name: 'Account Manager', description: null, permissions: {}, is_default: false }, error: null }
      if (has(ops, 'update')) return { data: null, error: null }
      return { data: [{ id: 'r9', name: 'Account Manager' }], error: null }
    }
    const { PATCH } = await import('@/app/api/team/roles/[id]/route')
    const res = await PATCH(patch({ name: `Account Lead${ZWSP}\n` }), params('r9'))
    expect(res.status).toBe(200)
    const upd = calls.find(c => c.table === 'roles' && has(c.ops, 'update'))!
    expect(upd.ops.find(o => o.name === 'update')!.args[0].name).toBe('Account Lead')
  })
})

describe('B2: an invite link is never built from an unset NEXT_PUBLIC_APP_URL', () => {
  const guard = "if (!process.env.NEXT_PUBLIC_APP_URL)"

  it('invite creation refuses before it deletes or inserts anything', () => {
    const src = read('app/api/team/invite/route.ts')
    const at = src.indexOf(guard)
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('const expiredIds = related.filter('))
    expect(at).toBeLessThan(src.indexOf('.insert({'))
  })

  it('Resend refuses before the existing token is rotated', () => {
    const src = read('app/api/team/[id]/resend/route.ts')
    const at = src.indexOf(guard)
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('.update({'))
  })
})
