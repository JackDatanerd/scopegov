// tests/settings-independent-pass-5.test.ts
//
// Settings independent pass 5 — B5: PATCH /api/workspace/branding conflict check.
// The save used to be refused whenever the WORKSPACE ROW's updated_at had moved, which any write to the row
// does (billing webhook, plan change, governing-law save). With a per-field `expected` baseline only a real
// change to the fields being written is a conflict. Same call-aware fake Supabase client as
// tests/settings-team-repass-3.test.ts.
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
  createServiceClient: () => ({
    from: (t: string) => chain(t),
    storage: { from: () => ({ list: async () => ({ data: [{ name: 'logo.png' }] }) }) },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))

const row = (extra: any = {}) => ({
  brand_colour: '#1a5c3a', logo_storage_path: null, agency_signature_data: null,
  updated_at: '2026-10-01T10:00:00.000+00:00', ...extra,
})
const patch = async (body: any) => {
  const { PATCH } = await import('@/app/api/workspace/branding/route')
  return PATCH(new NextRequest('http://localhost/api/workspace/branding', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}
const isUpdate = (ops: Op[]) => ops.some(o => o.name === 'update')

beforeEach(() => {
  calls.length = 0
  session = { id: 'actor', workspaceId: 'w1', name: 'A', email: 'a@x.com', workspaceName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
  resolver = (_t, ops) => isUpdate(ops) ? { data: [{ id: 'w1' }], error: null } : { data: row(), error: null }
})

describe('branding PATCH — per-field expected baseline', () => {
  it('saves a colour even though the row moved on for an unrelated reason (e.g. a billing webhook)', async () => {
    // The row's updated_at differs from anything the client holds, but its branding columns are as loaded.
    resolver = (_t, ops) => isUpdate(ops) ? { data: [{ id: 'w1' }], error: null } : { data: row({ updated_at: '2026-10-02T09:00:00.000+00:00' }), error: null }
    const res = await patch({ brandColour: '#223344', expected: { brandColour: '#1a5c3a' } })
    expect(res.status).toBe(200)
    expect((await res.json()).changed).toEqual(['brand_colour'])
  })

  it('refuses when the colour being written was changed by someone else', async () => {
    resolver = () => ({ data: row({ brand_colour: '#ff0000' }), error: null })
    const res = await patch({ brandColour: '#223344', expected: { brandColour: '#1a5c3a' } })
    expect(res.status).toBe(409)
    expect((await res.json()).conflicts).toEqual(['brandColour'])
  })

  it('compares the colour case-insensitively', async () => {
    const res = await patch({ brandColour: '#223344', expected: { brandColour: '#1A5C3A' } })
    expect(res.status).toBe(200)
  })

  it('refuses a signature save when a signature appeared since the page loaded', async () => {
    resolver = () => ({ data: row({ agency_signature_data: 'data:image/png;base64,AAAA' }), error: null })
    const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64')
    const res = await patch({ agencySignatureData: png, expected: { hasSignature: false } })
    expect(res.status).toBe(409)
    expect((await res.json()).conflicts).toEqual(['agencySignatureData'])
  })

  it('does not check fields the request is not writing', async () => {
    // Only the colour is being saved; a changed logo is not this save's business.
    resolver = (_t, ops) => isUpdate(ops) ? { data: [{ id: 'w1' }], error: null } : { data: row({ logo_storage_path: 'w1/logo.png' }), error: null }
    const res = await patch({ brandColour: '#223344', expected: { brandColour: '#1a5c3a', logoStoragePath: null } })
    expect(res.status).toBe(200)
  })

  it('retries when its own compare-and-swap loses to an unrelated write, then succeeds', async () => {
    let updates = 0
    resolver = (_t, ops) => {
      if (isUpdate(ops)) return updates++ === 0 ? { data: [], error: null } : { data: [{ id: 'w1' }], error: null }
      return { data: row(), error: null }
    }
    const res = await patch({ brandColour: '#223344', expected: { brandColour: '#1a5c3a' } })
    expect(res.status).toBe(200)
    expect(updates).toBe(2)
  })

  it('still honours expectedUpdatedAt for callers that send no `expected`', async () => {
    const res = await patch({ brandColour: '#223344', expectedUpdatedAt: '2026-09-01T00:00:00.000Z' })
    expect(res.status).toBe(409)
    expect((await res.json()).conflicts).toEqual(['branding'])
  })

  it('rejects a malformed `expected`', async () => {
    const res = await patch({ brandColour: '#223344', expected: 'nope' })
    expect(res.status).toBe(400)
  })
})
