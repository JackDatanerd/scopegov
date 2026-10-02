import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { createHmac } from 'node:crypto'
import { createFakeSupabase } from './helpers/fake-supabase'

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
const ev = (type: string, to: string) => ({ type, created_at: new Date().toISOString(), data: { email_id: 'prov_1', to: [to] } })

const WS = 'ws1', USER = 'u1'
// `a*@x.com` is a valid address. escapeLike() turns its `*` into the single-character wildcard `_`, so the ILIKE the webhook
// sends also matches `a?@x.com`. The fake's ilike treats `_` literally, so the look-alike below is `a_@x.com` — the one row
// the fake's pattern DOES return for that address — which is exactly the situation to guard: ILIKE returned a different client.
const world = (): Record<string, any[]> => ({
  email_log: [{ id: 'log1', workspace_id: WS, kind: 'invoice.send', entity_type: 'invoice', entity_id: 'i1', project_id: 'p1',
    actor_id: USER, to_emails: ['a*@x.com'], status: 'sent', provider_id: 'prov_1' }],
  clients: [
    { id: 'lookalike', workspace_id: WS, email: 'a_@x.com', email_bounced_at: null, email_bounce_kind: null },
  ],
  workspace_members: [{ user_id: USER, workspace_id: WS, status: 'active', effective_permissions: { VIEW_ALL_PROJECTS: true }, users: { id: USER, name: 'Jo', email: 'jo@agency.test' } }],
  workspace_notification_defaults: [], notification_preferences: [], notifications: [],
})

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('clients pass 15 — B2: the webhook marks only the client whose address it is', () => {
  it('a bounce for a*@x.com does not mark a different client the LIKE happened to return', async () => {
    h.db = createFakeSupabase(world())
    const r = await call(ev('email.bounced', 'a*@x.com'))
    expect(r.status).toBe(200)
    expect(h.db.tables.clients[0].email_bounced_at).toBeNull()
    expect(h.db.tables.clients[0].email_bounce_kind).toBeNull()
  })

  it('a spam complaint for a*@x.com does not mark the look-alike either', async () => {
    h.db = createFakeSupabase(world())
    await call(ev('email.complained', 'a*@x.com'))
    expect(h.db.tables.clients[0].email_bounce_kind).toBeNull()
  })

  it('a delivery to a*@x.com does not clear the look-alike client’s genuine bounce marker', async () => {
    const w = world()
    w.email_log[0].status = 'delivered'
    w.clients[0].email_bounced_at = '2026-01-01T00:00:00Z'; w.clients[0].email_bounce_kind = 'bounce'
    h.db = createFakeSupabase(w)
    await call(ev('email.delivered', 'a*@x.com'))
    expect(h.db.tables.clients[0].email_bounced_at).toBe('2026-01-01T00:00:00Z')
    expect(h.db.tables.clients[0].email_bounce_kind).toBe('bounce')
  })

  it('the exact client is still marked and cleared, matched case-insensitively', async () => {
    const w = world()
    w.email_log[0].to_emails = ['jane@acme.test']
    w.clients = [{ id: 'c1', workspace_id: WS, email: 'Jane@Acme.test', email_bounced_at: null, email_bounce_kind: null }]
    h.db = createFakeSupabase(w)
    await call(ev('email.bounced', 'jane@acme.test'))
    expect(h.db.tables.clients[0].email_bounce_kind).toBe('bounce')
    h.db.tables.email_log[0].status = 'delivered'
    await call(ev('email.delivered', 'jane@acme.test'))
    expect(h.db.tables.clients[0].email_bounced_at).toBeNull()
  })

  it('a client in another workspace is never touched', async () => {
    const w = world()
    w.email_log[0].to_emails = ['jane@acme.test']
    w.clients = [{ id: 'other', workspace_id: 'ws2', email: 'jane@acme.test', email_bounced_at: null, email_bounce_kind: null }]
    h.db = createFakeSupabase(w)
    await call(ev('email.bounced', 'jane@acme.test'))
    expect(h.db.tables.clients[0].email_bounce_kind).toBeNull()
  })

  it('the route filters candidates with sameEmail() and no longer updates straight off the ILIKE', () => {
    const src = readFileSync('app/api/webhooks/resend/route.ts', 'utf8')
    const body = src.slice(src.indexOf('async function trackClientEmailHealth'))
    expect(body).toContain('sameEmail(c.email, to)')
    expect(body).not.toMatch(/\.update\([^)]*\)[\s\S]{0,60}\.ilike\(/)
  })
})
