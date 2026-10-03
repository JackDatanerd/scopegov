import { describe, it, expect, vi, beforeEach } from 'vitest'

// Section 14 (independent pass 17):
//   B1  isBlankText missed invisible characters outside its hand-listed ranges (Khmer inherent vowels, U+180F, …).
//   B2  PATCH /api/clients/[id]: (a) the audit before/after comparison was key-order sensitive, so a whitespace-only
//       billing-address edit was logged as a change with identical from/to; (b) an empty body still ran the RPC.

const h = vi.hoisted(() => ({
  session: null as any,
  existing: null as any,
  rpcCalls: [] as any[],
  audits: [] as any[],
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => h.session,
  hasPermission: (s: any, p: string) => (s?.permissions || []).includes(p),
}))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async (_s: any, p: any) => { h.audits.push(p); return true } }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const b: any = new Proxy({}, {
        get: (_t, prop: string) => prop === 'then' ? (res: any) => res({ data: h.existing, error: null, count: 0 }) : () => b,
      })
      return b
    },
    rpc: async (name: string, args: any) => { h.rpcCalls.push({ name, args }); return { data: { ok: true, updated: true }, error: null } },
  }),
}))

import { isBlankText } from '@/lib/utils/client-input'
import { PATCH as patchClient } from '@/app/api/clients/[id]/route'

const ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const req = (body: any) => ({ json: async () => body, headers: new Headers() }) as any
const call = (body: any) => patchClient(req(body), { params: Promise.resolve({ id: ID }) })

beforeEach(() => {
  h.session = { id: 'u1', email: 'a@b.co', name: 'A', workspaceId: 'w1', permissions: ['CREATE_PROJECTS', 'VIEW_CLIENT_DATA'] }
  // jsonb returns keys shortest-first, not in the parser's line1/line2/city… order
  h.existing = { id: ID, name: 'Acme', email: 'old@acme.test', cc_emails: [], status: 'active', billing_address: { city: 'Nairobi', line1: '1 Rd', country: 'Kenya' } }
  h.rpcCalls.length = 0
  h.audits.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('B1 — isBlankText', () => {
  it('treats Default_Ignorable / format characters the old list missed as blank', () => {
    for (const s of ['\u17b4', '\u17b5\u17b4', '\u180f', '\u{1d173}', '\u{1bca0}', ' \u17b4 ']) expect(isBlankText(s), JSON.stringify(s)).toBe(true)
  })
  it('still accepts real names, including ones with joiners and combining marks', () => {
    for (const s of ['Jane', 'José', '李', 'ខ្មែរ', 'क्षत्रिय', 'x\u200dy', '\u200bJane', '김\u3164민']) expect(isBlankText(s), s).toBe(false)
  })
})

describe('B2 — PATCH /api/clients/[id]', () => {
  it('an empty body writes nothing', async () => {
    const res = await call({})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, unchanged: true })
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
  })
  it('a body of unknown keys writes nothing', async () => {
    const res = await call({ bogus: 1 })
    expect(await res.json()).toEqual({ ok: true, unchanged: true })
    expect(h.rpcCalls).toHaveLength(0)
  })
  it('an address that differs only in key order / whitespace is not audited as a change', async () => {
    const res = await call({ billingAddress: { line1: ' 1 Rd ', city: 'Nairobi', country: 'Kenya' } })
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.audits).toHaveLength(0)
  })
  it('a real address change is still audited with before and after', async () => {
    await call({ billingAddress: { line1: '2 Rd', city: 'Nairobi', country: 'Kenya' } })
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0].metadata.fields).toEqual(['billing_address'])
  })
  it('a status-only change still goes through and is audited as archive', async () => {
    await call({ status: 'archived' })
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.audits[0].eventType).toBe('client.archived')
  })
})
