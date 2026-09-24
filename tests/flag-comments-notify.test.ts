import { describe, it, expect, beforeEach, vi } from 'vitest'

const notifyUsers = vi.fn(async (..._a: any[]) => ({ recipients: [], inserted: true }))
const getMembers = vi.fn(async (..._a: any[]) => [{ id: 'approver1' }, { id: 'approver2' }])
let flag: any
let priorAuthors: any[]

vi.mock('@/lib/utils/notify', () => ({ notifyUsers: (...a: any[]) => notifyUsers(...a) }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMembersWithPermission: (...a: any[]) => getMembers(...a) }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {} }))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '1.1.1.1' }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'me', name: 'Me', workspaceId: 'w1', email: 'me@x.test', avatarUrl: null }),
}))
vi.mock('@/lib/utils/flag-governance', () => ({
  resolveEntity: async () => ({ projectId: 'p1' }),
  canReadProject: async () => true,
  canWriteGovernance: () => true,
  isValidEntityType: () => true,
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const chain: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'single') return async () => ({ data: table === 'guardian_flags' ? flag : table === 'flag_comments' ? { id: 'c-new', created_at: 'now' } : null, error: null })
          if (prop === 'then') return (res: any) => res({ data: table === 'flag_comments' ? priorAuthors : [], error: null })
          return () => chain
        },
      })
      return chain
    },
  }),
}))

import { POST } from '@/app/api/scope-governance/[entityType]/[entityId]/comments/route'

const call = (text: string) => POST(
  { json: async () => ({ body: text }) } as any,
  { params: Promise.resolve({ entityType: 'flag', entityId: 'f1' }) } as any,
)

beforeEach(() => { notifyUsers.mockClear(); getMembers.mockClear(); priorAuthors = []; flag = { resolved_by: null, escalated_to: null, sow_reference: 'SOW-0001 §2' } })

describe('flag comment notifications', () => {
  it('reaches the owner AND earlier commenters, never the commenter, in one notification', async () => {
    flag.resolved_by = 'owner1'
    priorAuthors = [{ author_id: 'asker' }, { author_id: 'me' }, { author_id: 'owner1' }]
    await call('Looks fine to me')
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    const p = notifyUsers.mock.calls[0][1]
    expect(new Set(p.recipientIds)).toEqual(new Set(['owner1', 'asker']))
    expect(p.body).toBe('Me: Looks fine to me')
    expect(p.title).toBe('New comment on scope flag — SOW-0001 §2')
  })

  it('an unowned flag goes to the people who can act on it, plus earlier commenters', async () => {
    priorAuthors = [{ author_id: 'asker' }]
    await call('hello')
    const p = notifyUsers.mock.calls[0][1]
    expect(new Set(p.recipientIds)).toEqual(new Set(['approver1', 'approver2', 'asker']))
  })

  it('has no dangling dash in the title when the flag cites no SOW reference', async () => {
    flag.resolved_by = 'owner1'; flag.sow_reference = null
    await call('hi')
    expect(notifyUsers.mock.calls[0][1].title).toBe('New comment on scope flag')
  })

  it('truncates a long comment in the notification body', async () => {
    flag.resolved_by = 'owner1'
    await call('x'.repeat(300))
    const body: string = notifyUsers.mock.calls[0][1].body
    expect(body.length).toBeLessThan(160)
    expect(body.endsWith('…')).toBe(true)
  })
})
