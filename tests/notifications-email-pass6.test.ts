import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

// Notifications & email independent pass 6.
//  1. filterByNotificationPreference: one unchunked .in('user_id', <whole workspace>) + ignored read errors.
//     filterToProjectAccess: ignored read error (fail-closed, now logged).
//  2. workspace notification-defaults route ignored read errors (GET answered 200 "all defaults"; PATCH took the INSERT branch).
//  3. personal preferences PATCH wrote BOTH columns from a stale read — overlapping Email/Bell toggles clobbered each other.

const h = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'a@x.test', name: 'A', workspaceId: 'ws1', workspaceName: 'W', agencyName: 'W' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {} }))

import { filterByNotificationPreference, filterToProjectAccess } from '@/lib/utils/permissions-query'
import { GET as defaultsGET, PATCH as defaultsPATCH } from '@/app/api/workspace/notification-defaults/route'
import { PATCH as prefsPATCH } from '@/app/api/notifications/preferences/route'

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}` }))
const patch = (body: any) => prefsPATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }) as any)

describe('filterByNotificationPreference', () => {
  it('applies an opt-out for a recipient far past the first lookup chunk, using bounded id lists', async () => {
    h.db = createFakeSupabase({
      workspace_notification_defaults: [],
      notification_preferences: [{ user_id: 'u240', workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: false, in_app_enabled: true }],
    })
    const out = await filterByNotificationPreference(h.db.client, 'ws1', 'sow_signed', people(250), 'email')
    expect(out).toHaveLength(249)
    expect(out.find(r => r.id === 'u240')).toBeUndefined()
    // 250 recipients -> 3 chunk reads, none larger than 100 ids
    expect(h.db.calls.filter((c: any) => c.table === 'notification_preferences' && c.op === 'select')).toHaveLength(3)
  })

  it('a failed preference read is logged and fails OPEN (does not throw, does not drop recipients)', async () => {
    h.db = createFakeSupabase({ workspace_notification_defaults: [], notification_preferences: [] },
      { errors: [{ table: 'notification_preferences', op: 'select', times: 1 }] })
    const out = await filterByNotificationPreference(h.db.client, 'ws1', 'sow_signed', people(3), 'email')
    expect(out).toHaveLength(3)
    expect(console.error).toHaveBeenCalled()
  })

  it('a failed workspace-default read is logged rather than silent', async () => {
    h.db = createFakeSupabase({ workspace_notification_defaults: [], notification_preferences: [] },
      { errors: [{ table: 'workspace_notification_defaults', op: 'select', times: 1 }] })
    await filterByNotificationPreference(h.db.client, 'ws1', 'sow_signed', people(2), 'email')
    expect(console.error).toHaveBeenCalled()
  })

  it('a locked-off default still removes everyone', async () => {
    h.db = createFakeSupabase({ workspace_notification_defaults: [{ workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: false, in_app_enabled: true, locked: true }] })
    expect(await filterByNotificationPreference(h.db.client, 'ws1', 'sow_signed', people(3), 'email')).toEqual([])
  })
})

describe('filterToProjectAccess', () => {
  it('a failed member read fails CLOSED for non-VIEW_ALL recipients and is logged', async () => {
    h.db = createFakeSupabase({ project_members_active: [] }, { errors: [{ table: 'project_members_active', op: 'select', times: 1 }] })
    const perms = new Map<string, Record<string, boolean>>([['a', { VIEW_ALL_PROJECTS: true }], ['b', {}]])
    const out = await filterToProjectAccess(h.db.client, 'p1', [{ id: 'a' }, { id: 'b' }], perms)
    expect(out.map(r => r.id)).toEqual(['a'])
    expect(console.error).toHaveBeenCalled()
  })
})

describe('workspace notification-defaults route — read errors', () => {
  it('GET answers 500, not an all-enabled 200, when the read fails', async () => {
    h.db = createFakeSupabase({ workspace_notification_defaults: [] }, { errors: [{ table: 'workspace_notification_defaults', op: 'select', times: 1 }] })
    expect((await defaultsGET()).status).toBe(500)
  })

  it('PATCH does not write when the existing-row lookup fails', async () => {
    h.db = createFakeSupabase({ workspace_notification_defaults: [{ id: 'd1', workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: true, in_app_enabled: true, locked: false }] },
      { errors: [{ table: 'workspace_notification_defaults', op: 'select', times: 1 }] })
    const res = await defaultsPATCH({ json: async () => ({ eventType: 'sow_signed', enabled: false, locked: true }) } as any)
    expect(res.status).toBe(500)
    expect(h.db.tables.workspace_notification_defaults[0].locked).toBe(false)
    expect(h.db.calls.filter((c: any) => c.op === 'insert' || c.op === 'update')).toHaveLength(0)
  })

  it('a duplicate-key INSERT (two admins saving a new event at once) falls back to updating the row', async () => {
    h.db = createFakeSupabase({ workspace_notification_defaults: [] }, { unique: () => true })
    const res = await defaultsPATCH({ json: async () => ({ eventType: 'sow_signed', enabled: false, locked: false }) } as any)
    expect(res.status).toBe(200)
    const upd = h.db.calls.find((c: any) => c.op === 'update')
    expect(upd).toBeTruthy()
    expect('in_app_enabled' in upd.payload).toBe(false)
  })
})

describe('preferences PATCH — column-targeted write', () => {
  const row = (over: Row = {}) => ({ user_id: 'u1', workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: true, in_app_enabled: false, ...over })

  it('updates only the targeted column of an existing row', async () => {
    h.db = createFakeSupabase({ notification_preferences: [row()], workspace_notification_defaults: [] })
    expect((await patch({ eventType: 'sow_signed', enabled: false, channel: 'email' })).status).toBe(200)
    const upd = h.db.calls.filter((c: any) => c.table === 'notification_preferences' && c.op === 'update')
    expect(upd).toHaveLength(1)
    expect(upd[0].payload).toEqual({ email_enabled: false })
    expect(h.db.tables.notification_preferences[0].in_app_enabled).toBe(false)
  })

  it('a stale read cannot write back the other channel: a concurrent Bell change survives an Email change', async () => {
    h.db = createFakeSupabase({ notification_preferences: [row({ in_app_enabled: true })], workspace_notification_defaults: [] })
    // The other request lands between this request's read and its write.
    const realFrom = h.db.client.from.bind(h.db.client)
    h.db.client.from = (t: string) => {
      const b = realFrom(t)
      if (t !== 'notification_preferences') return b
      const ms = b.maybeSingle.bind(b)
      b.maybeSingle = async () => { const out = await ms(); h.db.tables.notification_preferences[0].in_app_enabled = false; return out }
      return b
    }
    expect((await patch({ eventType: 'sow_signed', enabled: false, channel: 'email' })).status).toBe(200)
    const r = h.db.tables.notification_preferences[0]
    expect(r.email_enabled).toBe(false)
    expect(r.in_app_enabled).toBe(false)
  })

  it('a first-ever toggle creates the row from the workspace default baseline, then sets only the target', async () => {
    h.db = createFakeSupabase({
      notification_preferences: [],
      workspace_notification_defaults: [{ workspace_id: 'ws1', event_type: 'sow_signed', email_enabled: false, in_app_enabled: true, locked: false }],
    })
    expect((await patch({ eventType: 'sow_signed', enabled: false, channel: 'in_app' })).status).toBe(200)
    expect(h.db.tables.notification_preferences).toHaveLength(1)
    const r = h.db.tables.notification_preferences[0]
    expect(r.email_enabled).toBe(false)   // baseline from the org default, not reset to true
    expect(r.in_app_enabled).toBe(false)  // the toggled channel
  })

  it('an in-app-only event sets only in_app_enabled', async () => {
    h.db = createFakeSupabase({ notification_preferences: [], workspace_notification_defaults: [] })
    expect((await patch({ eventType: 'member_joined', enabled: false })).status).toBe(200)
    const r = h.db.tables.notification_preferences[0]
    expect(r.in_app_enabled).toBe(false)
    expect(r.email_enabled).toBe(true)
  })
})
