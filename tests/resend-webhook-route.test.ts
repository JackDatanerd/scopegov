import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))

import { POST } from '@/app/api/webhooks/resend/route'

const RAW = Buffer.from('route-test-secret').toString('base64')
process.env.RESEND_WEBHOOK_SECRET = `whsec_${RAW}`

function req(event: any) {
  const body = JSON.stringify(event)
  const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000))
  const sig = 'v1,' + createHmac('sha256', Buffer.from(RAW, 'base64')).update(`${id}.${ts}.${body}`).digest('base64')
  return new Request('http://x/api/webhooks/resend', { method: 'POST', body, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig } }) as any
}
const call = async (event: any) => { const r = await POST(req(event)); return { status: r.status, body: await r.json() } }
const bounce = (to: string) => ({ type: 'email.bounced', created_at: new Date().toISOString(), data: { email_id: 'prov_1', to: [to] } })

const WS = 'ws1', USER = 'u1'
const world = (): Record<string, any[]> => ({
  email_log: [{ id: 'log1', workspace_id: WS, kind: 'invoice.send', entity_type: 'invoice', entity_id: 'i1', project_id: 'p1',
    actor_id: USER, to_emails: ['client@acme.test'], status: 'sent', provider_id: 'prov_1' }],
  clients: [
    { id: 'c1', workspace_id: WS, email: 'client@acme.test', email_bounced_at: null, email_bounce_kind: null },
  ],
  workspace_members: [{ user_id: USER, workspace_id: WS, status: 'active', effective_permissions: { VIEW_ALL_PROJECTS: true }, users: { id: USER, name: 'Jo', email: 'jo@agency.test' } }],
  workspace_notification_defaults: [], notification_preferences: [], notifications: [],
})

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('resend webhook', () => {
  it('a bounced CC does NOT mark the client\'s primary address as bounced', async () => {
    h.db = createFakeSupabase(world())
    const r = await call(bounce('finance@acme.test'))
    expect(r.status).toBe(200)
    expect(h.db.tables.clients[0].email_bounced_at).toBeNull()
    expect(h.db.tables.notifications[0].title).toContain('finance@acme.test')
  })

  it('a bounce of the primary address still marks the client', async () => {
    h.db = createFakeSupabase(world())
    await call(bounce('Client@Acme.test'))
    expect(h.db.tables.clients[0].email_bounce_kind).toBe('bounce')
  })

  it('if the bounce alert cannot be written the status is put back and the webhook fails so Resend retries', async () => {
    h.db = createFakeSupabase(world(), { errors: [{ table: 'notifications', op: 'insert', times: 1 }] })
    const first = await call(bounce('client@acme.test'))
    expect(first.status).toBe(500)
    expect(h.db.tables.email_log[0].status).toBe('sent')
    const retry = await call(bounce('client@acme.test'))
    expect(retry.status).toBe(200)
    expect(h.db.tables.notifications).toHaveLength(1)
    expect(h.db.tables.email_log[0].status).toBe('bounced')
  })

  it('an event that beats the email_log insert is retried, an old unknown one is dropped', async () => {
    h.db = createFakeSupabase({ ...world(), email_log: [] })
    expect((await call(bounce('client@acme.test'))).status).toBe(503)
    const old = { ...bounce('client@acme.test'), created_at: new Date(Date.now() - 10 * 60_000).toISOString() }
    const r = await call(old)
    expect(r.status).toBe(200); expect(r.body.untracked).toBe(true)
  })

  it('a delivery to the primary clears its bounce marker even when another recipient\'s event already advanced the status', async () => {
    const w = world(); w.email_log[0].status = 'delivered'
    w.clients[0].email_bounced_at = '2026-01-01T00:00:00Z'; w.clients[0].email_bounce_kind = 'bounce'
    h.db = createFakeSupabase(w)
    await call({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 'prov_1', to: ['client@acme.test'] } })
    expect(h.db.tables.clients[0].email_bounced_at).toBeNull()
  })
})
