import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { EMAIL_RE, normalizeCcEmails, parseClientInput } from '@/lib/utils/client-input'

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
        get: (_t, prop: string) => prop === 'then'
          ? (res: any) => res({ data: h.existing, error: null })
          : () => b,
      })
      return b
    },
    rpc: async (name: string, args: any) => { h.rpcCalls.push({ name, args }); return { data: { ok: true, updated: true }, error: null } },
  }),
}))

import { PATCH } from '@/app/api/clients/[id]/route'

const ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const req = (body: any) => ({ json: async () => body, headers: new Headers() }) as any
const call = (body: any) => PATCH(req(body), { params: Promise.resolve({ id: ID }) })

beforeEach(() => {
  h.session = { id: 'u1', email: 'a@b.co', name: 'A', workspaceId: 'w1', permissions: ['CREATE_PROJECTS', 'VIEW_CLIENT_DATA'] }
  h.existing = { id: ID, name: 'Acme', email: 'old@acme.test', cc_emails: [], phone: null, status: 'active', workspace_id: 'w1' }
  h.rpcCalls.length = 0; h.audits.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('clients pass 12 — B1: EMAIL_RE rejects addressing characters that make an address undeliverable', () => {
  const BAD = [
    'jane@acme.com,', '<jane@acme.com>', 'a,b@x.com', 'a;b@x.com', 'a@x.com>', 'a@x.com;',
    '"a b"@x.com', 'a@[1.2.3.4]', 'a\\b@x.com', '(c)a@x.com', 'a:b@x.com',
  ]
  it.each(BAD)('rejects %s', e => { expect(EMAIL_RE.test(e)).toBe(false) })

  it('keeps every ordinary address (plus tags, apostrophes, underscores, non-ASCII letters)', () => {
    for (const e of ['a@b.co', 'jane+tag@sub.acme.co.ke', 'josé@exämple.com', "o'brien@x.com", 'first_last@x.io', 'user@münchen.de'])
      expect(EMAIL_RE.test(e)).toBe(true)
  })

  it('the earlier dot / invisible-character rules still hold', () => {
    for (const e of ['a@x..com', 'a..b@x.com', 'a@.x.com', 'a@x.com.', 'a\u200b@x.com', 'a@x.com\u0000'])
      expect(EMAIL_RE.test(e)).toBe(false)
  })

  it('create, update and the CC list all refuse a pasted trailing comma / angle brackets', () => {
    expect(parseClientInput({ name: 'N', email: 'jane@acme.com,' }, 'create').ok).toBe(false)
    expect(parseClientInput({ email: '<jane@acme.com>' }, 'update').ok).toBe(false)
    expect(normalizeCcEmails(['ok@x.com', 'bad@x.com>']).ok).toBe(false)
  })
})

describe('clients pass 12 — B2: archive / reactivate have their own audit events', () => {
  it('a status-only change to archived is client.archived', async () => {
    const res = await call({ status: 'archived' })
    expect(res.status).toBe(200)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0].eventType).toBe('client.archived')
  })
  it('a status-only change back to active is client.unarchived', async () => {
    h.existing = { ...h.existing, status: 'archived' }
    await call({ status: 'active' })
    expect(h.audits[0].eventType).toBe('client.unarchived')
  })
  it('a status change together with another field stays client.updated and names both', async () => {
    await call({ status: 'archived', phone: '+254 700 000000' })
    expect(h.audits[0].eventType).toBe('client.updated')
    expect(h.audits[0].metadata.fields).toEqual(expect.arrayContaining(['status', 'phone']))
  })
  it('a plain edit stays client.updated, and a no-op status write records nothing', async () => {
    await call({ phone: '+254 700 000000' })
    expect(h.audits[0].eventType).toBe('client.updated')
    h.audits.length = 0
    await call({ status: 'active' })
    expect(h.audits).toHaveLength(0)
  })
  it('the client page labels both events', () => {
    const src = readFileSync('app/(app)/clients/[id]/page.tsx', 'utf8')
    expect(src).toMatch(/'client\.archived': 'Archived'/)
    expect(src).toMatch(/'client\.unarchived': 'Reactivated'/)
  })
})

describe('clients pass 12 — B3: merge keeps a source contact’s routing role when the target already has the address', () => {
  const sql = readFileSync('supabase/migrations/135_merge_clients_keep_role_type_on_duplicate.sql', 'utf8')
  it('defines merge_clients with the role_type carry-over, only upgrading a target copy that is "other"', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.merge_clients\(/)
    expect(sql).toMatch(/UPDATE public\.client_contacts tc\s+SET role_type = sc\.role_type/)
    expect(sql).toMatch(/tc\.role_type = 'other'/)
    expect(sql).toMatch(/sc\.role_type <> 'other'/)
    expect(sql).toMatch(/lower\(tc\.email\) = lower\(sc\.email\)/)
  })
  it('runs the upgrade before the source row is deleted, and keeps 126’s grants', () => {
    expect(sql.indexOf("tc.role_type = 'other'")).toBeLessThan(sql.indexOf('DELETE FROM public.clients WHERE id = p_source'))
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.merge_clients\(uuid, uuid, uuid\) FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.merge_clients\(uuid, uuid, uuid\) TO service_role;/)
  })
})
