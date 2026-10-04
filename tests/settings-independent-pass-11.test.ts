// tests/settings-independent-pass-11.test.ts
//
// Settings independent pass 11 — bug 2: PATCH /api/workspace/settings { replyToEmail } coerced any non-string value
// to '' and so silently CLEARED the saved reply-to address with a 200. Only null / a blank string clear it now;
// any other non-string is a 400 and writes nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

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
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (t: string) => chain(t) }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))

const isUpdate = (ops: Op[]) => ops.some(o => o.name === 'update')
const row = (extra: any = {}) => ({
  id: 'w1', name: 'Acme', slug: 'acme', reply_to_email: 'old@acme.com', currency: 'USD', timezone: 'UTC',
  updated_at: '2026-10-01T10:00:00.000+00:00', slug_changed_at: null, onboarding_completed_at: '2026-09-01T00:00:00.000+00:00',
  proactive_risk_threshold: 10000, ...extra,
})
const patch = async (body: any) => {
  const { PATCH } = await import('@/app/api/workspace/settings/route')
  return PATCH(new NextRequest('http://localhost/api/workspace/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}
const wroteUpdate = () => calls.some(c => isUpdate(c.ops))

beforeEach(() => {
  calls.length = 0
  session = { id: 'actor', workspaceId: 'w1', name: 'A', email: 'a@x.com', workspaceName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
  resolver = (_t, ops) => isUpdate(ops) ? { data: [{ id: 'w1' }], error: null } : { data: row(), error: null }
})

describe('settings PATCH — replyToEmail', () => {
  it.each([12345, true, { a: 1 }, ['x@y.com']])('rejects a non-string value (%j) instead of clearing the saved address', async (bad) => {
    const res = await patch({ replyToEmail: bad })
    expect(res.status).toBe(400)
    expect(wroteUpdate()).toBe(false)
  })

  it('still clears the address for null', async () => {
    const res = await patch({ replyToEmail: null })
    expect(res.status).toBe(200)
    expect(wroteUpdate()).toBe(true)
  })

  it('still clears the address for a blank string', async () => {
    const res = await patch({ replyToEmail: '   ' })
    expect(res.status).toBe(200)
    expect(wroteUpdate()).toBe(true)
  })

  it('still saves a valid address', async () => {
    const res = await patch({ replyToEmail: 'hello@acme.com' })
    expect(res.status).toBe(200)
    expect(wroteUpdate()).toBe(true)
  })
})
