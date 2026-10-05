// tests/settings-independent-pass-14.test.ts
//
// Settings independent pass 14:
//  B1. workspace reply-to email was validated with the loose delivery regex (SIMPLE_EMAIL): NUL / lone surrogates
//      failed the save with a generic 500; invisible characters, `..`, trailing dot / `)` / curly quote were stored
//      and then sent as a malformed Reply-To on every client-facing email.
//  B2. GET /api/workspace/defaults answered 200 with currency 'USD' when its workspace read failed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { isValidReplyTo } from '@/lib/email/send'
import { resolveReplyTo } from '@/lib/email/reply-to'

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
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))

const isUpdate = (ops: Op[]) => ops.some(o => o.name === 'update')
const row = (extra: any = {}) => ({
  id: 'w1', name: 'Acme', slug: 'acme', reply_to_email: null, currency: 'USD', timezone: 'UTC', governing_law: 'Kenya',
  updated_at: '2026-10-01T10:00:00.000+00:00', slug_changed_at: null, onboarding_completed_at: '2026-09-01T00:00:00.000+00:00',
  proactive_risk_threshold: 10000, client_reminder_max: 3, client_reminder_after_days: 3, ...extra,
})

beforeEach(() => {
  calls.length = 0
  session = { id: 'actor', workspaceId: 'w1', name: 'A', email: 'a@x.com', workspaceName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
  resolver = (_t, ops) => isUpdate(ops) ? { data: [{ id: 'w1' }], error: null } : { data: row(), error: null }
})

const BAD = ['a\u0000@b.co', 'billing@acme.com\u200b', 'a@x..com', '.a@x.com', 'a@x.com.', 'a\ud800@b.co', 'a@x.com)', 'a@x.com\u201d']

describe('B1 — reply-to validation', () => {
  it.each(BAD)('PATCH rejects %j with a 400 and writes nothing', async (bad) => {
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(new NextRequest('http://localhost/api/workspace/settings', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replyToEmail: bad }),
    }))
    expect(res.status).toBe(400)
    expect(calls.some(c => isUpdate(c.ops))).toBe(false)
  })

  it('a normal address is still saved', async () => {
    const { PATCH } = await import('@/app/api/workspace/settings/route')
    const res = await PATCH(new NextRequest('http://localhost/api/workspace/settings', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replyToEmail: 'billing@acme.com' }),
    }))
    expect(res.status).toBe(200)
    expect(calls.find(c => isUpdate(c.ops))?.ops.find(o => o.name === 'update')?.args[0].reply_to_email).toBe('billing@acme.com')
  })

  it('isValidReplyTo accepts ordinary addresses and refuses every malformed one', () => {
    for (const ok of ['billing@acme.com', 'jane+tag@acme.co.uk', "o'brien@acme.com"]) expect(isValidReplyTo(ok)).toBe(true)
    for (const bad of BAD) expect(isValidReplyTo(bad)).toBe(false)
  })

  it('a legacy stored malformed reply-to is not used on outgoing mail: falls back to the actor', async () => {
    const svc: any = { from: () => chain('workspaces') }
    resolver = () => ({ data: { reply_to_email: 'billing@acme.com\u200b' }, error: null })
    expect(await resolveReplyTo(svc, 'w1', 'actor@acme.com')).toBe('actor@acme.com')
  })
})

describe('B2 — defaults GET refuses to answer from a failed workspace read', () => {
  it('returns 500, not 200 with USD', async () => {
    resolver = (t) => t === 'workspaces' ? { data: null, error: { message: 'boom' } } : { data: [], error: null }
    const { GET } = await import('@/app/api/workspace/defaults/route')
    const res = await GET(new NextRequest('http://localhost/api/workspace/defaults?projectType=web'))
    expect(res.status).toBe(500)
  })
  it('still answers normally when the read works', async () => {
    resolver = (t) => t === 'workspaces' ? { data: { currency: 'KES', governing_law: 'Kenya', sow_language: 'en' }, error: null } : { data: [], error: null }
    const { GET } = await import('@/app/api/workspace/defaults/route')
    const res = await GET(new NextRequest('http://localhost/api/workspace/defaults'))
    expect(res.status).toBe(200)
    expect((await res.json()).currency).toBe('KES')
  })
})
