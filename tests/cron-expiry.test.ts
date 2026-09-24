import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any,
  audits: [] as any[],
  notified: [] as any[],
  alerts: [] as any[],
  heartbeats: [] as any[],
  emails: [] as any[],
}))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/audit', () => ({ insertAuditRow: async (_s: any, row: any) => { h.audits.push(row); return true } }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async (_s: any, p: any) => { h.notified.push(p) } }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => ['ops@agency.test'] }))
vi.mock('@/lib/email/templates', () => ({
  sendSowExpiredEmail: async (p: any) => { h.emails.push(['sow', p]) },
  sendCoExpiredEmail: async (p: any) => { h.emails.push(['co', p]) },
}))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: async (...a: any[]) => { h.alerts.push(a) } }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async (_s: any, name: string, result: any) => { h.heartbeats.push({ name, result }) } }))

import { POST as coExpiry } from '@/app/api/cron/co-expiry/route'
import { POST as sowExpiry } from '@/app/api/cron/sow-expiry/route'

const PAST = '2020-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'
const call = async (fn: any) => { const res = await fn({} as any); return { status: res.status, body: await res.json() } }
const proj = { id: 'p1', name: 'Acme site', clients: { name: 'Acme' } }
const co = (over: Row = {}) => ({ id: 'co1', title: 'Extra pages', workspace_id: 'w1', project_id: 'p1', flag_id: null, status: 'awaiting_response', expires_at: PAST, token: 'tok-co1', projects: proj, ...over })
const sow = (over: Row = {}) => ({ id: 's1', version: 1, workspace_id: 'w1', project_id: 'p1', status: 'awaiting_signature', expires_at: PAST, token: 'tok-s1', projects: { ...proj, status: 'Awaiting Signature' }, ...over })

beforeEach(() => {
  h.audits.length = 0; h.notified.length = 0; h.alerts.length = 0; h.heartbeats.length = 0; h.emails.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('cron/co-expiry', () => {
  it('expires an overdue CO, revokes its token, audits, notifies and records a heartbeat', async () => {
    h.db = createFakeSupabase({ change_orders: [co()], revoked_tokens: [], guardian_flags: [] })
    const { status, body } = await call(coExpiry)
    expect(status).toBe(200)
    expect(body.expired).toBe(1)
    const row = h.db.tables.change_orders[0]
    expect(row.status).toBe('expired'); expect(row.token).toBeNull()
    expect(h.db.tables.revoked_tokens[0]).toMatchObject({ token: 'tok-co1', token_type: 'co', reason: 'expired', document_id: 'co1' })
    expect(h.audits.map(a => a.event_type)).toContain('co.expired')
    expect(h.notified).toHaveLength(1)
    expect(h.heartbeats).toEqual([{ name: 'co-expiry', result: { expired: 1 } }])
  })

  it('leaves live and non-expirable COs alone (not yet due; countered is an open negotiation)', async () => {
    h.db = createFakeSupabase({ change_orders: [co({ id: 'a', expires_at: FUTURE }), co({ id: 'b', status: 'countered' }), co({ id: 'c', status: 'accepted' })], revoked_tokens: [] })
    const { body } = await call(coExpiry)
    expect(body.expired).toBe(0)
    expect(h.db.tables.change_orders.map((r: Row) => r.status)).toEqual(['awaiting_response', 'countered', 'accepted'])
  })

  it('releases the linked Guardian flag back to open — but only if it still points at THIS CO', async () => {
    h.db = createFakeSupabase({
      change_orders: [co({ id: 'co1', flag_id: 'f1' }), co({ id: 'co2', flag_id: 'f2', token: 'tok-co2' })],
      guardian_flags: [
        { id: 'f1', status: 'converted_to_co', change_order_id: 'co1' },
        { id: 'f2', status: 'converted_to_co', change_order_id: 'newer-revision' }, // already re-claimed by a revision
      ],
      revoked_tokens: [],
    })
    await call(coExpiry)
    const flags = h.db.tables.guardian_flags
    expect(flags.find((f: Row) => f.id === 'f1')).toMatchObject({ status: 'open', change_order_id: null })
    expect(flags.find((f: Row) => f.id === 'f2')).toMatchObject({ status: 'converted_to_co', change_order_id: 'newer-revision' })
    expect(h.audits.filter(a => a.event_type === 'flag.reverted_to_open')).toHaveLength(1)
  })

  it('a failing UPDATE is no longer a silent green run: the row error alerts and is reported in the body', async () => {
    h.db = createFakeSupabase({ change_orders: [co()], revoked_tokens: [] }, { errors: [{ table: 'change_orders', op: 'update', message: 'check constraint violated' }] })
    const { status, body } = await call(coExpiry)
    expect(status).toBe(200)                         // one poison row must not withhold the heartbeat…
    expect(body.expired).toBe(0)
    expect(body.rowErrors?.[0]).toMatch(/check constraint violated/) // …but it is reported…
    expect(h.alerts).toHaveLength(1)                 // …and pages ops
    expect(h.db.tables.change_orders[0].status).toBe('awaiting_response')
  })

  it('a failing candidate SELECT fails the run outright: 500, alert, NO heartbeat', async () => {
    h.db = createFakeSupabase({ change_orders: [co()] }, { errors: [{ table: 'change_orders', op: 'select', message: 'db down' }] })
    const { status } = await call(coExpiry)
    expect(status).toBe(500)
    expect(h.alerts).toHaveLength(1)
    expect(h.heartbeats).toHaveLength(0)
  })

  it('treats an already-revoked token (23505) as the goal state, not a failure', async () => {
    h.db = createFakeSupabase({ change_orders: [co()], revoked_tokens: [{ id: 'r', token: 'tok-co1' }] }, { unique: (t, row, ex) => t === 'revoked_tokens' && ex.some(e => e.token === row.token) })
    const { body } = await call(coExpiry)
    expect(body.expired).toBe(1)
    expect(body.rowErrors).toBeUndefined()
  })
})

describe('cron/sow-expiry', () => {
  it('expires an overdue SOW, revokes the token and un-stalls the project it had auto-stalled', async () => {
    h.db = createFakeSupabase({
      sow_documents: [sow()], revoked_tokens: [],
      projects: [{ id: 'p1', status: 'Stalled', stall_reason: 'sow_unsigned' }],
    })
    const { body } = await call(sowExpiry)
    expect(body.expired).toBe(1)
    expect(h.db.tables.sow_documents[0]).toMatchObject({ status: 'expired', token: null })
    expect(h.db.tables.revoked_tokens[0]).toMatchObject({ token: 'tok-s1', token_type: 'sow', reason: 'expired' })
    expect(h.db.tables.projects[0]).toMatchObject({ status: 'Awaiting Signature', stall_reason: null })
    expect(h.notified).toHaveLength(1)
  })

  it('does not touch a project stalled for some other reason', async () => {
    h.db = createFakeSupabase({ sow_documents: [sow()], revoked_tokens: [], projects: [{ id: 'p1', status: 'Stalled', stall_reason: 'manual' }] })
    await call(sowExpiry)
    expect(h.db.tables.projects[0]).toMatchObject({ status: 'Stalled', stall_reason: 'manual' })
  })

  it("does not announce a 'changes_requested' version's link expiring", async () => {
    h.db = createFakeSupabase({ sow_documents: [sow({ status: 'changes_requested' })], revoked_tokens: [], projects: [] })
    const { body } = await call(sowExpiry)
    expect(body.expired).toBe(1)
    expect(h.notified).toHaveLength(0)
  })

  it('a failing UPDATE alerts instead of reporting a healthy zero', async () => {
    h.db = createFakeSupabase({ sow_documents: [sow()], revoked_tokens: [] }, { errors: [{ table: 'sow_documents', op: 'update', message: 'permission denied' }] })
    const { body } = await call(sowExpiry)
    expect(body.expired).toBe(0)
    expect(body.rowErrors?.[0]).toMatch(/permission denied/)
    expect(h.alerts).toHaveLength(1)
  })

  it('a failing project reconcile is reported as a row error, not swallowed', async () => {
    h.db = createFakeSupabase({ sow_documents: [sow()], revoked_tokens: [], projects: [{ id: 'p1', status: 'Stalled', stall_reason: 'sow_unsigned' }] },
      { errors: [{ table: 'projects', op: 'update', message: 'rls' }] })
    const { body } = await call(sowExpiry)
    expect(body.expired).toBe(1)
    expect(body.rowErrors?.join(' ')).toMatch(/project status reconcile/)
  })
})
