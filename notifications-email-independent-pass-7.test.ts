import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

// Notifications & email independent pass 7.
//  B1. email.suppressed / email.failed never reached the sender (only bounces and complaints alerted).
//  B2. a first toggle of one channel froze the OTHER channel at the day's workspace default (migration 142: NULL = inherit).
//  B3. the webhook answered 503 for every success event on mail that was never logged (most internal mail).
//  B4 is a client-only fix (NotificationsClient.remove) and is covered by reading, not here.

const h = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'a@x.test', name: 'A', workspaceId: 'ws1', workspaceName: 'W', agencyName: 'W' }),
  hasPermission: () => true,
}))

import { POST } from '@/app/api/webhooks/resend/route'
import { PATCH as prefsPATCH, GET as prefsGET } from '@/app/api/notifications/preferences/route'
import { filterByNotificationPreference } from '@/lib/utils/permissions-query'
import { failureKindForEvent, nextEmailStatus, suppressedAlertBody, failedAlertBody } from '@/lib/email/webhook'
import { sendEmail, __setResendForTests } from '@/lib/email/send'

const RAW = Buffer.from('pass7-secret').toString('base64')
process.env.RESEND_WEBHOOK_SECRET = `whsec_${RAW}`
function req(event: any) {
  const body = JSON.stringify(event)
  const id = 'msg_7', ts = String(Math.floor(Date.now() / 1000))
  const sig = 'v1,' + createHmac('sha256', Buffer.from(RAW, 'base64')).update(`${id}.${ts}.${body}`).digest('base64')
  return new Request('http://x/api/webhooks/resend', { method: 'POST', body, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig } }) as any
}
const call = async (event: any) => { const r = await POST(req(event)); return { status: r.status, body: await r.json() } }
const ev = (type: string, to: string, extra: Record<string, any> = {}, emailId = 'prov_1') =>
  ({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: [to], ...extra } })

const WS = 'ws1', USER = 'u1'
const world = (): Record<string, any[]> => ({
  email_log: [{ id: 'log1', workspace_id: WS, kind: 'invoice.reminder', entity_type: 'invoice', entity_id: 'i1', project_id: 'p1',
    actor_id: USER, to_emails: ['client@acme.test'], status: 'sent', provider_id: 'prov_1', created_at: new Date(Date.now() - 60_000).toISOString() }],
  clients: [{ id: 'c1', workspace_id: WS, email: 'client@acme.test', email_bounced_at: null, email_bounce_kind: null }],
  workspace_members: [{ user_id: USER, workspace_id: WS, status: 'active', effective_permissions: { VIEW_ALL_PROJECTS: true }, users: { id: USER, name: 'Jo', email: 'jo@agency.test' } }],
  workspace_notification_defaults: [], notification_preferences: [], notifications: [],
})

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('B1 — suppressed and failed sends are reported to the sender', () => {
  it('maps the events', () => {
    expect(failureKindForEvent('email.bounced')).toBe('bounced')
    expect(failureKindForEvent('email.complained')).toBe('complained')
    expect(failureKindForEvent('email.suppressed')).toBe('suppressed')
    expect(failureKindForEvent('email.failed')).toBe('failed')
    expect(failureKindForEvent('email.delivered')).toBeNull()
    expect(nextEmailStatus('sent', 'email.suppressed')).toBe('failed')
    expect(suppressedAlertBody('invoice')).toContain('suppression list')
    expect(failedAlertBody('invoice')).toContain('could not be sent')
  })

  it('a suppressed send raises a bell alert, marks the failed status and keeps the client\'s bounce marker', async () => {
    h.db = createFakeSupabase(world())
    const r = await call(ev('email.suppressed', 'Client@Acme.test'))
    expect(r.status).toBe(200)
    expect(h.db.tables.email_log[0].status).toBe('failed')
    expect(h.db.tables.notifications).toHaveLength(1)
    expect(h.db.tables.notifications[0].title).toBe('Email to client@acme.test was not sent')
    expect(h.db.tables.notifications[0].type).toBe('invoice_email_suppressed')
    expect(h.db.tables.clients[0].email_bounce_kind).toBe('bounce')
  })

  it('a provider-side failure alerts the sender but never touches the client record', async () => {
    h.db = createFakeSupabase(world())
    const r = await call(ev('email.failed', 'client@acme.test', { failed: { reason: 'reached_daily_quota' } }))
    expect(r.status).toBe(200)
    expect(h.db.tables.email_log[0].status).toBe('failed')
    expect(h.db.tables.notifications[0].title).toBe('Email to client@acme.test could not be sent')
    expect(h.db.tables.clients[0].email_bounced_at).toBeNull()
  })

  it('a redelivered suppressed event does not alert twice, and a lost alert makes Resend retry', async () => {
    h.db = createFakeSupabase(world(), { errors: [{ table: 'notifications', op: 'insert', times: 1 }] })
    expect((await call(ev('email.suppressed', 'client@acme.test'))).status).toBe(500)
    expect(h.db.tables.email_log[0].status).toBe('sent')        // rolled back so the retry advances again
    expect((await call(ev('email.suppressed', 'client@acme.test'))).status).toBe(200)
    expect((await call(ev('email.suppressed', 'client@acme.test'))).status).toBe(200)
    expect(h.db.tables.notifications).toHaveLength(1)
  })
})

describe('B3 — success events for mail that was never logged are not retried', () => {
  const noLog = () => ({ ...world(), email_log: [] as Row[] })

  it('an untagged delivered event for an unlogged email is dropped at once (200), not 503', async () => {
    h.db = createFakeSupabase(noLog())
    const r = await call(ev('email.delivered', 'x@y.test'))
    expect(r.status).toBe(200); expect(r.body.untracked).toBe(true)
  })

  it('a delivered event carrying the tracked tag still waits for its log row (503)', async () => {
    h.db = createFakeSupabase(noLog())
    expect((await call(ev('email.delivered', 'x@y.test', { tags: { tracked: '1' } }))).status).toBe(503)
    expect((await call(ev('email.delivery_delayed', 'x@y.test', { tags: [{ name: 'tracked', value: '1' }] }))).status).toBe(503)
  })

  it('failure events are always retried while fresh, tag or no tag', async () => {
    h.db = createFakeSupabase(noLog())
    expect((await call(ev('email.bounced', 'x@y.test'))).status).toBe(503)
    expect((await call(ev('email.suppressed', 'x@y.test'))).status).toBe(503)
  })
})

describe('B3 — sendEmail tags the sends it logs', () => {
  const base = { from: '"A via ScopeGov" <noreply@x.test>', subject: 's', html: '<p>x</p>', to: 'c@example.com' }
  it('adds tracked=1 only when a log context is given', async () => {
    const calls: any[] = []
    __setResendForTests({ emails: { send: async (b: any) => { calls.push(b); return { data: { id: 'e1' }, error: null } } } } as any)
    h.db = createFakeSupabase({ email_log: [] })
    await sendEmail({ ...base })
    await sendEmail({ ...base }, { workspaceId: 'ws1', kind: 'sow.send' })
    expect(calls[0].tags).toBeUndefined()
    expect(calls[1].tags).toEqual([{ name: 'tracked', value: '1' }])
  })
})

describe('B2 — a never-chosen channel inherits the workspace default', () => {
  const patch = (body: any) => prefsPATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }) as any)
  const def = (over: Record<string, any>) => ({ workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: true, in_app_enabled: true, locked: false, ...over })

  it('muting only the bell leaves email NULL, so a later admin change to the email default reaches the member', async () => {
    h.db = createFakeSupabase({ notification_preferences: [], workspace_notification_defaults: [def({})] })
    expect((await patch({ eventType: 'sow_signed', enabled: false, channel: 'in_app' })).status).toBe(200)
    const row = h.db.tables.notification_preferences[0]
    expect(row.in_app_enabled).toBe(false); expect(row.email_enabled).toBeNull()

    // admin turns the email default off afterwards
    h.db.tables.workspace_notification_defaults[0].email_enabled = false
    const email = await filterByNotificationPreference(h.db.client, 'ws1', 'sow_signed', [{ id: 'u1' }], 'email')
    expect(email).toHaveLength(0)                                   // inherited, not frozen at the old `true`
    const bell = await filterByNotificationPreference(h.db.client, 'ws1', 'sow_signed', [{ id: 'u1' }], 'in_app')
    expect(bell).toHaveLength(0)                                    // their own bell choice still stands
  })

  it('an explicit choice still beats the workspace default', async () => {
    h.db = createFakeSupabase({
      notification_preferences: [{ user_id: 'u1', workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: true, in_app_enabled: null }],
      workspace_notification_defaults: [def({ email_enabled: false })],
    })
    expect(await filterByNotificationPreference(h.db.client, 'ws1', 'sow_signed', [{ id: 'u1' }], 'email')).toHaveLength(1)
    expect(await filterByNotificationPreference(h.db.client, 'ws1', 'sow_signed', [{ id: 'u1' }], 'in_app')).toHaveLength(1)
  })

  it('GET reports a NULL channel as the workspace default', async () => {
    h.db = createFakeSupabase({
      notification_preferences: [{ user_id: 'u1', workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: null, in_app_enabled: false }],
      workspace_notification_defaults: [def({ email_enabled: false })],
    })
    const json = await (await prefsGET()).json()
    expect(json.prefs.sow_signed).toBe(false)        // default, not coerced to a stored value
    expect(json.inAppPrefs.sow_signed).toBe(false)   // the member's own bell choice
  })

  it('falls back to the old baseline write when migration 142 has not been applied (NOT NULL violation)', async () => {
    h.db = createFakeSupabase(
      { notification_preferences: [], workspace_notification_defaults: [def({ email_enabled: false })] },
      { errors: [{ table: 'notification_preferences', op: 'upsert', code: '23502', message: 'null value violates not-null', times: 1 }] },
    )
    expect((await patch({ eventType: 'sow_signed', enabled: false, channel: 'in_app' })).status).toBe(200)
    const row = h.db.tables.notification_preferences[0]
    expect(row.email_enabled).toBe(false)   // baseline from the default
    expect(row.in_app_enabled).toBe(false)
  })
})
