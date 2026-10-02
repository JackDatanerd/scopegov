import { describe, it, expect, vi, beforeEach } from 'vitest'

// Section 14 (independent pass 16 — B1): a name made only of zero-width / invisible characters passed every
// "name is required" check (String.trim() removes whitespace only) and was stored as a blank-looking client or contact.

const h = vi.hoisted(() => ({
  session: null as any,
  existing: null as any,
  rpcCalls: [] as any[],
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => h.session,
  hasPermission: (s: any, p: string) => (s?.permissions || []).includes(p),
}))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      // client_contacts reads are list reads (duplicate / count checks); everything else is a single-row lookup.
      const data = table === 'client_contacts' ? [] : h.existing
      const b: any = new Proxy({}, {
        get: (_t, prop: string) => prop === 'then' ? (res: any) => res({ data, error: null, count: 0 }) : () => b,
      })
      return b
    },
    rpc: async (name: string, args: any) => { h.rpcCalls.push({ name, args }); return { data: { ok: true, updated: true, client_id: 'new' }, error: null } },
  }),
}))

import { isBlankText, parseClientInput } from '@/lib/utils/client-input'
import { POST as createClient } from '@/app/api/clients/route'
import { PATCH as patchClient } from '@/app/api/clients/[id]/route'
import { POST as addContact } from '@/app/api/clients/[id]/contacts/route'
import { PATCH as patchContact } from '@/app/api/clients/[id]/contacts/[contactId]/route'

const ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const CID = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2'
const INVISIBLE = ['\u200b', '\u200b\u200b', '\u2060', '\ufeff', '\u00ad', '\u200d', ' \u200b \u200e ', '\u3164', '\u2800', '\ufe0f', '\u{e0020}']
const req = (body: any) => ({ json: async () => body, headers: new Headers() }) as any

beforeEach(() => {
  h.session = { id: 'u1', email: 'a@b.co', name: 'A', workspaceId: 'w1', permissions: ['CREATE_PROJECTS', 'VIEW_CLIENT_DATA'] }
  h.existing = { id: ID, name: 'Acme', email: 'old@acme.test', cc_emails: [], billing_address: null, role: null, role_type: 'other', is_primary: false }
  h.rpcCalls.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('isBlankText', () => {
  it('is true for empty, whitespace and invisible-only text', () => {
    expect(isBlankText('')).toBe(true)
    expect(isBlankText('   \t\n')).toBe(true)
    for (const s of INVISIBLE) expect(isBlankText(s), JSON.stringify(s)).toBe(true)
    expect(isBlankText(null)).toBe(true)
    expect(isBlankText(42)).toBe(true)
  })
  it('is false when any visible character is present, including real names that contain joiners', () => {
    expect(isBlankText('Jane')).toBe(false)
    expect(isBlankText('\u200bJane')).toBe(false)
    expect(isBlankText('A')).toBe(false)
    expect(isBlankText('محمد')).toBe(false)
    expect(isBlankText('क्‍ष')).toBe(false)        // Devanagari with a ZWJ in the middle
    expect(isBlankText('李')).toBe(false)
    expect(isBlankText('0')).toBe(false)
  })
})

describe('parseClientInput', () => {
  it('rejects an invisible-only name on create and on update', () => {
    for (const s of INVISIBLE) {
      expect(parseClientInput({ name: s, email: 'a@b.co' }, 'create')).toEqual({ ok: false, error: 'Name is required' })
      expect(parseClientInput({ name: s }, 'update')).toEqual({ ok: false, error: 'Name is required' })
    }
  })
  it('stores an invisible-only optional text field as null instead of as junk', () => {
    const r = parseClientInput({ companyName: '\u200b', phone: '\u2060', notes: '\ufeff', vatNumber: ' \u200b ' }, 'update') as any
    expect(r.ok).toBe(true)
    expect(r.updates).toMatchObject({ company_name: null, phone: null, notes: null, vat_number: null })
  })
  it('still accepts and trims a normal name', () => {
    expect((parseClientInput({ name: '  Jane Mwangi ', email: 'a@b.co' }, 'create') as any).updates.name).toBe('Jane Mwangi')
  })
})

describe('client routes', () => {
  it('POST /api/clients refuses an invisible-only name and never reaches create_client', async () => {
    for (const s of INVISIBLE) {
      const res = await createClient(req({ name: s, email: 'a@b.co' }))
      expect(res.status, JSON.stringify(s)).toBe(400)
    }
    expect(h.rpcCalls).toHaveLength(0)
  })
  it('PATCH /api/clients/[id] refuses an invisible-only name', async () => {
    const res = await patchClient(req({ name: '\u200b' }), { params: Promise.resolve({ id: ID }) })
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })
})

describe('contact routes', () => {
  it('POST contacts refuses an invisible-only name', async () => {
    for (const s of INVISIBLE) {
      const res = await addContact(req({ name: s, email: 'j@acme.test' }), { params: Promise.resolve({ id: ID }) })
      expect(res.status, JSON.stringify(s)).toBe(400)
    }
    expect(h.rpcCalls).toHaveLength(0)
  })
  it('POST contacts stores an invisible-only role as null', async () => {
    h.existing = { id: ID, name: 'Acme' }
    await addContact(req({ name: 'Jane', email: 'j@acme.test', role: '\u200b' }), { params: Promise.resolve({ id: ID }) })
    const call = h.rpcCalls.find(c => c.name === 'client_contact_add')
    expect(call?.args.p_role).toBeNull()
  })
  it('PATCH contacts refuses an invisible-only name', async () => {
    const res = await patchContact(req({ name: '\u200b' }), { params: Promise.resolve({ id: ID, contactId: CID }) })
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })
})
