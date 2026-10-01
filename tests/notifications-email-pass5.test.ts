import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

// Notifications & email independent pass 5.
//  1. Resend webhook: an event that LOSES the guarded email_log status update (a concurrent event for another recipient
//     won it) used to answer 200 "unchanged" having raised no alert and marked nothing — and a 200 is never retried.
//  2. /api/notifications/preferences ignored read errors (GET answered 200 with every toggle on; PATCH wrote the channel
//     being left alone from the wrong baseline).

const h = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'a@x.test', name: 'A', workspaceId: 'ws1', workspaceName: 'W' }),
}))

import { POST } from '@/app/api/webhooks/resend/route'
import { GET as prefsGET, PATCH as prefsPATCH } from '@/app/api/notifications/preferences/route'

const RAW = Buffer.from('route-test-secret').toString('base64')
process.env.RESEND_WEBHOOK_SECRET = `whsec_${RAW}`

function req(event: any) {
  const body = JSON.stringify(event)
  const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000))
  const sig = 'v1,' + createHmac('sha256', Buffer.from(RAW, 'base64')).update(`${id}.${ts}.${body}`).digest('base64')
  return new Request('http://x/api/webhooks/resend', { method: 'POST', body, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig } }) as any
}
const call = async (event: any) => { const r = await POST(req(event)); return { status: r.status, body: await r.json() } }
const ev = (type: string, to: string) => ({ type, created_at: new Date().toISOString(), data: { email_id: 'prov_1', to: [to] } })

const WS = 'ws1', USER = 'u1'
const world = (): Record<string, any[]> => ({
  email_log: [{ id: 'log1', workspace_id: WS, kind: 'invoice.send', entity_type: 'invoice', entity_id: 'i1', project_id: 'p1',
    actor_id: USER, to_emails: ['client@acme.test', 'finance@acme.test'], status: 'sent', provider_id: 'prov_1',
    created_at: new Date(Date.now() - 5 * 60_000).toISOString() }],
  clients: [{ id: 'c1', workspace_id: WS, email: 'client@acme.test', email_bounced_at: null, email_bounce_kind: null }],
  workspace_members: [{ user_id: USER, workspace_id: WS, status: 'active', effective_permissions: { VIEW_ALL_PROJECTS: true }, users: { id: USER, name: 'Jo', email: 'jo@agency.test' } }],
  workspace_notification_defaults: [], notification_preferences: [], notifications: [],
})

/** Simulates a concurrent event winning the status update between this request's read and its guarded write. */
function withConcurrentWinner(db: any, winnerStatus: string) {
  const realFrom = db.client.from.bind(db.client)
  let armed = true
  db.client.from = (table: string) => {
    const b = realFrom(table)
    if (table !== 'email_log') return b
    const realMaybeSingle = b.maybeSingle?.bind(b)
    if (realMaybeSingle) {
      b.maybeSingle = async (...a: any[]) => {
        const out = await realMaybeSingle(...a)
        if (armed && out?.data) { armed = false; db.tables.email_log[0].status = winnerStatus }
        return out
      }
    }
    return b
  }
  return db
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('resend webhook — lost status race', () => {
  it('a bounce that loses the status update to a concurrent delivered event still alerts and marks the client', async () => {
    h.db = withConcurrentWinner(createFakeSupabase(world()), 'delivered')
    const r = await call(ev('email.bounced', 'client@acme.test'))
    expect(r.status).toBe(200)
    expect(h.db.tables.notifications.map((n: Row) => n.title)).toEqual(['Email to client@acme.test bounced'])
    expect(h.db.tables.clients[0].email_bounce_kind).toBe('bounce')
  })

  it('a delivery that loses the race still clears the address\'s stale bounce marker', async () => {
    const w = world()
    w.clients[0].email_bounced_at = '2026-01-01T00:00:00Z'; w.clients[0].email_bounce_kind = 'bounce'
    h.db = withConcurrentWinner(createFakeSupabase(w), 'delayed')
    const r = await call(ev('email.delivered', 'client@acme.test'))
    expect(r.status).toBe(200)
    expect(h.db.tables.clients[0].email_bounced_at).toBeNull()
  })

  it('a losing bounce whose alert cannot be written fails (500) so Resend retries, and the retry lands once', async () => {
    h.db = withConcurrentWinner(createFakeSupabase(world(), { errors: [{ table: 'notifications', op: 'insert', times: 1 }] }), 'delivered')
    expect((await call(ev('email.bounced', 'client@acme.test'))).status).toBe(500)
    expect((await call(ev('email.bounced', 'client@acme.test'))).status).toBe(200)
    expect(h.db.tables.notifications).toHaveLength(1)
  })
})

describe('notification preferences route — read errors', () => {
  const prefs = (rows: Row[] = []) => ({ notification_preferences: rows, workspace_notification_defaults: [] as Row[] })

  it('GET answers 500, not an all-enabled 200, when a read fails', async () => {
    h.db = createFakeSupabase(prefs(), { errors: [{ table: 'notification_preferences', op: 'select', times: 1 }] })
    expect((await prefsGET()).status).toBe(500)
    h.db = createFakeSupabase(prefs(), { errors: [{ table: 'workspace_notification_defaults', op: 'select', times: 1 }] })
    expect((await prefsGET()).status).toBe(500)
  })

  it('GET still returns the resolved preferences when reads succeed', async () => {
    h.db = createFakeSupabase(prefs([{ user_id: 'u1', workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: false, in_app_enabled: true }]))
    const res = await prefsGET()
    expect(res.status).toBe(200)
    expect((await res.json()).prefs.sow_signed).toBe(false)
  })

  it('PATCH does not write when the existing-row read fails (the other channel must not be reset)', async () => {
    h.db = createFakeSupabase(prefs([{ user_id: 'u1', workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: true, in_app_enabled: false }]),
      { errors: [{ table: 'notification_preferences', op: 'select', times: 1 }] })
    const res = await prefsPATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ eventType: 'sow_signed', enabled: false, channel: 'email' }) }) as any)
    expect(res.status).toBe(500)
    expect(h.db.tables.notification_preferences[0].in_app_enabled).toBe(false)
    expect(h.db.tables.notification_preferences[0].email_enabled).toBe(true)
  })

  it('PATCH does not write when the workspace-default read fails (the lock check cannot be skipped)', async () => {
    h.db = createFakeSupabase(prefs(), { errors: [{ table: 'workspace_notification_defaults', op: 'select', times: 1 }] })
    const res = await prefsPATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ eventType: 'sow_signed', enabled: false }) }) as any)
    expect(res.status).toBe(500)
    expect(h.db.tables.notification_preferences).toHaveLength(0)
  })

  it('PATCH preserves the untouched channel on the normal path', async () => {
    h.db = createFakeSupabase(prefs([{ user_id: 'u1', workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: true, in_app_enabled: false }]))
    const res = await prefsPATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ eventType: 'sow_signed', enabled: false, channel: 'email' }) }) as any)
    expect(res.status).toBe(200)
    const row = h.db.tables.notification_preferences[0]
    expect(row.email_enabled).toBe(false); expect(row.in_app_enabled).toBe(false)
  })
})
