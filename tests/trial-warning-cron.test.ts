import { describe, it, expect, beforeEach, vi } from 'vitest'

const sendTrial = vi.fn(async (..._a: any[]) => ({ ok: true as const, id: 'e1' }))
const notifyUsers = vi.fn(async (..._a: any[]) => ({ recipients: [{ id: 'h1' }], inserted: true }))
const audits: any[] = []
let creatorActive: boolean
let bellAlreadySent: boolean
let holders: any[]

vi.mock('@/lib/email/templates', () => ({ sendTrialWarningEmail: (...a: any[]) => sendTrial(...a) }))
vi.mock('@/lib/utils/notify', () => ({ notifyUsers: (...a: any[]) => notifyUsers(...a) }))
vi.mock('@/lib/utils/permissions-query', () => ({
  getMembersWithPermission: async () => holders,
  filterByNotificationPreference: async (_s: any, _w: string, _e: string, r: any[]) => r,
}))
vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/utils/audit', () => ({ insertAuditRow: async (_s: any, row: any) => { audits.push(row) } }))
vi.mock('@/lib/utils/cron-run', () => ({
  CronRun: class {
    result: Record<string, unknown> = {}
    constructor(..._a: any[]) {}
    async step(_n: string, fn: () => Promise<void>) { await fn() }
    rowError(label: string, e: unknown) { throw e }
    async finish() { return { body: { ok: true, ...this.result }, status: 200 } }
  },
  fetchAll: async () => [{
    id: 'w1', agency_name: 'Acme', created_by: 'creator', billing: null,
    trial_ends_at: new Date(Date.now() + 2.5 * 86400000).toISOString(),
    creator: { name: 'Cee', email: 'creator@x.test' },
  }],
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const chain: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'maybeSingle') return async () => {
            if (table === 'workspace_members') return { data: creatorActive ? { id: 'm' } : null, error: null }
            if (table === 'audit_log') return { data: bellAlreadySent && chain.__bell ? { id: 'a' } : null, error: null }
            return { data: null, error: null }
          }
          if (prop === 'eq') return (col: string, val: unknown) => { if (val === 'billing.trial_ending_bell') chain.__bell = true; return chain }
          return () => chain
        },
      })
      return chain
    },
  }),
}))

import { POST } from '@/app/api/cron/trial-warning/route'

beforeEach(() => {
  sendTrial.mockClear(); notifyUsers.mockClear(); audits.length = 0
  creatorActive = true; bellAlreadySent = false
  holders = [{ id: 'h1', name: 'Hal', email: 'hal@x.test' }]
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/cron/trial-warning', () => {
  it('emails billing holders and the active creator, and raises the bell once', async () => {
    await POST({} as any)
    expect(sendTrial.mock.calls.map(c => c[0].to).sort()).toEqual(['creator@x.test', 'hal@x.test'])
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    const p = notifyUsers.mock.calls[0][1]
    expect(p).toMatchObject({ type: 'trial_ending', eventType: 'trial_ending', entityType: 'workspace', entityId: 'w1' })
    expect(p.recipientIds).toEqual(expect.arrayContaining(['h1', 'creator']))
    expect(audits.some(a => a.event_type === 'billing.trial_ending_bell')).toBe(true)
  })

  it('does not warn a creator who is no longer an active member', async () => {
    creatorActive = false
    await POST({} as any)
    expect(sendTrial.mock.calls.map(c => c[0].to)).toEqual(['hal@x.test'])
    expect(notifyUsers.mock.calls[0][1].recipientIds).not.toContain('creator')
  })

  it('does not raise the bell twice on the same day', async () => {
    bellAlreadySent = true
    await POST({} as any)
    expect(notifyUsers).not.toHaveBeenCalled()
  })
})
