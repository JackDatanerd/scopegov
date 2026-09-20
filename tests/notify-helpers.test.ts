import { describe, it, expect, beforeEach, vi } from 'vitest'
import { insertNotificationRows, notifySecurityEvent, notifyUsers } from '@/lib/utils/notify'

function fakeService(opts: { memberships?: any[]; members?: any[]; insertError?: any; membersError?: any }) {
  const inserted: any[] = []
  const service = {
    from: (table: string) => {
      const chain: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'insert') return async (rows: any) => { inserted.push({ table, rows }); return { error: opts.insertError ?? null } }
          if (prop === 'then') {
            const data = table === 'workspace_members' ? (opts.memberships ?? opts.members ?? []) : []
            return (resolve: any) => resolve({ data, error: opts.membersError ?? null })
          }
          return () => chain
        },
      })
      return chain
    },
  }
  return { service, inserted }
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('insertNotificationRows', () => {
  it('reports a failed insert instead of assuming success (supabase-js returns { error }, it does not throw)', async () => {
    const { service } = fakeService({ insertError: { message: 'null value in column "workspace_id"' } })
    expect(await insertNotificationRows(service, [{ x: 1 }])).toBe(false)
  })
  it('succeeds on a clean insert and is a no-op for an empty batch', async () => {
    const { service, inserted } = fakeService({})
    expect(await insertNotificationRows(service, [{ x: 1 }])).toBe(true)
    expect(await insertNotificationRows(service, [])).toBe(true)
    expect(inserted).toHaveLength(1)
  })
})

describe('notifySecurityEvent — one row per active workspace membership', () => {
  it('writes a row for every workspace so the notice shows in each bell', async () => {
    const { service, inserted } = fakeService({ memberships: [{ workspace_id: 'w1' }, { workspace_id: 'w2' }] })
    await notifySecurityEvent(service, 'u1', 'MFA enabled', 'body')
    const rows = inserted[0].rows
    expect(rows.map((r: any) => r.workspace_id)).toEqual(['w1', 'w2'])
    expect(rows.every((r: any) => r.recipient_id === 'u1' && r.type === 'security' && r.project_id === null)).toBe(true)
  })
  it('never inserts a row with a null workspace_id (a person with no workspace simply gets none)', async () => {
    const { service, inserted } = fakeService({ memberships: [] })
    await notifySecurityEvent(service, 'u1', 't', 'b')
    expect(inserted).toHaveLength(0)
  })
  it('swallows a lookup failure — a security notice must never break the MFA flow that raised it', async () => {
    const { service } = fakeService({ membersError: { message: 'db down' } })
    await expect(notifySecurityEvent(service, 'u1', 't', 'b')).resolves.toBeUndefined()
  })
})

describe('notifyUsers', () => {
  const base = { workspaceId: 'w1', type: 't', title: 'T', body: 'B' }
  it('does nothing when the only recipient is the actor', async () => {
    const { service, inserted } = fakeService({})
    const r = await notifyUsers(service, { ...base, recipientIds: ['a'], excludeUserId: 'a' })
    expect(r).toEqual({ recipients: [], inserted: true })
    expect(inserted).toHaveLength(0)
  })
  it('ignores null/undefined ids and dedupes', async () => {
    const { service, inserted } = fakeService({
      members: [{ user_id: 'u1', effective_permissions: {}, users: { id: 'u1', name: 'U', email: 'u@x.test' } }],
    })
    const r = await notifyUsers(service, { ...base, recipientIds: ['u1', 'u1', null, undefined] })
    expect(r.recipients.map(x => x.id)).toEqual(['u1'])
    expect(inserted[0].rows).toHaveLength(1)
    expect(inserted[0].rows[0]).toMatchObject({ workspace_id: 'w1', recipient_id: 'u1', type: 't', entity_type: null, project_id: null })
  })
  it('reports (not throws) when the insert fails', async () => {
    const { service } = fakeService({
      members: [{ user_id: 'u1', effective_permissions: {}, users: { id: 'u1', name: 'U', email: 'u@x.test' } }],
      insertError: { message: 'nope' },
    })
    const r = await notifyUsers(service, { ...base, recipientIds: ['u1'] })
    expect(r.inserted).toBe(false)
  })
  it('a lookup failure yields no recipients rather than an exception', async () => {
    const { service } = fakeService({ membersError: { message: 'db down' } })
    await expect(notifyUsers(service, { ...base, recipientIds: ['u1'] })).resolves.toEqual({ recipients: [], inserted: false })
  })
})
