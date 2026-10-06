import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))

import { POST } from '@/app/api/webhooks/resend/route'
import { sendInvoicePaymentRecordedEmail } from '@/lib/email/templates'
import { __setResendForTests } from '@/lib/email/send'

const RAW = Buffer.from('route-test-secret').toString('base64')
process.env.RESEND_WEBHOOK_SECRET = `whsec_${RAW}`

function req(event: any) {
  const body = JSON.stringify(event)
  const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000))
  const sig = 'v1,' + createHmac('sha256', Buffer.from(RAW, 'base64')).update(`${id}.${ts}.${body}`).digest('base64')
  return new Request('http://x/api/webhooks/resend', { method: 'POST', body, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig } }) as any
}
const call = async (event: any) => { const r = await POST(req(event)); return { status: r.status, body: await r.json() } }
const ev = (type: string, to: string, emailId: string) =>
  ({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: [to], tags: [{ name: 'tracked', value: '1' }] } })

const WS = 'ws1', USER = 'u1'
const world = (): Record<string, any[]> => ({
  email_log: [
    { id: 'log1', workspace_id: WS, kind: 'invoice.send', project_id: 'p1', actor_id: USER, to_emails: ['client@acme.test'],
      status: 'sent', provider_id: 'prov_1', created_at: '2026-10-01T10:00:00Z' },
    { id: 'log2', workspace_id: WS, kind: 'invoice.send', project_id: 'p1', actor_id: USER, to_emails: ['client@acme.test'],
      status: 'sent', provider_id: 'prov_2', created_at: '2026-10-01T10:05:00Z' },
  ],
  clients: [{ id: 'c1', workspace_id: WS, email: 'client@acme.test', email_bounced_at: null, email_bounce_kind: null }],
  workspace_members: [{ user_id: USER, workspace_id: WS, status: 'active', effective_permissions: { VIEW_ALL_PROJECTS: true },
    users: { id: USER, name: 'Jo', email: 'jo@agency.test' } }],
  workspace_notification_defaults: [], notification_preferences: [], notifications: [],
})
// Migration 149's two functions, as the database would run them.
function claimRpc(db: () => any) {
  return {
    claim_email_alert: (a: any) => {
      const row = db().tables.email_log.find((r: any) => r.id === a.p_email_log_id)
      row.alerted_keys = row.alerted_keys || []
      if (row.alerted_keys.includes(a.p_key)) return { data: false, error: null }
      row.alerted_keys.push(a.p_key); return { data: true, error: null }
    },
    release_email_alert: (a: any) => {
      const row = db().tables.email_log.find((r: any) => r.id === a.p_email_log_id)
      row.alerted_keys = (row.alerted_keys || []).filter((k: string) => k !== a.p_key); return { data: null, error: null }
    },
  }
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('bounce alert is claimed per email (pass 13, bug 3)', () => {
  it('a second email to the same address still alerts even though an alert for the first one exists', async () => {
    h.db = createFakeSupabase(world(), { rpc: claimRpc(() => h.db) })
    // Alert for email 1 is raised AFTER email 2 was logged — the old time-window dedupe would match it for email 2.
    h.db.tables.email_log[0].status = 'bounced'
    expect((await call(ev('email.bounced', 'client@acme.test', 'prov_1'))).status).toBe(200)
    h.db.tables.email_log[1].status = 'bounced'
    expect((await call(ev('email.bounced', 'client@acme.test', 'prov_2'))).status).toBe(200)
    expect(h.db.tables.notifications).toHaveLength(2)
  })
  it('a redelivery of the same event does not alert twice', async () => {
    h.db = createFakeSupabase(world(), { rpc: claimRpc(() => h.db) })
    await call(ev('email.bounced', 'client@acme.test', 'prov_1'))
    await call(ev('email.bounced', 'client@acme.test', 'prov_1'))
    expect(h.db.tables.notifications).toHaveLength(1)
  })
  it('a failed alert write gives the claim back so the retry raises it', async () => {
    h.db = createFakeSupabase(world(), { rpc: claimRpc(() => h.db), errors: [{ table: 'notifications', op: 'insert', times: 1 }] })
    expect((await call(ev('email.bounced', 'client@acme.test', 'prov_1'))).status).toBe(500)
    expect(h.db.tables.email_log[0].alerted_keys).toEqual([])
    expect((await call(ev('email.bounced', 'client@acme.test', 'prov_1'))).status).toBe(200)
    expect(h.db.tables.notifications).toHaveLength(1)
  })
})

describe('late delivery does not wipe a newer bounce marker (pass 13, bug 5)', () => {
  it('delivery of an email sent BEFORE the marker leaves it; one sent AFTER clears it', async () => {
    const w = world()
    w.clients[0].email_bounced_at = '2026-10-01T10:08:00Z'; w.clients[0].email_bounce_kind = 'bounce'
    h.db = createFakeSupabase(w)
    await call(ev('email.delivered', 'client@acme.test', 'prov_2')) // sent 10:05 < marker 10:08
    expect(h.db.tables.clients[0].email_bounce_kind).toBe('bounce')
    h.db.tables.clients[0].email_bounced_at = '2026-10-01T10:02:00Z' // marker predates email 2
    await call(ev('email.delivered', 'client@acme.test', 'prov_2'))
    expect(h.db.tables.clients[0].email_bounce_kind).toBeNull()
  })
})

describe('payment-recorded email with an unknown balance (pass 13, bug 4)', () => {
  it('omits the remaining-balance line instead of printing a zero balance', async () => {
    const send = vi.fn(async () => ({ data: { id: 'e1' }, error: null }))
    __setResendForTests({ emails: { send } } as any)
    const base = { to: ['a@agency.test'], agencyName: 'A', clientName: 'C', projectName: 'P', amount: 100, currency: 'USD', isFullyPaid: false, projectUrl: 'https://x.test/p' }
    await sendInvoicePaymentRecordedEmail({ ...base, balanceRemaining: null })
    expect((send.mock.calls[0] as any)[0].html).not.toContain('Remaining balance')
    await sendInvoicePaymentRecordedEmail({ ...base, balanceRemaining: 50 })
    expect((send.mock.calls[1] as any)[0].html).toContain('Remaining balance')
  })
})
