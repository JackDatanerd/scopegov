import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── module mocks (everything the route imports that talks to the outside world) ──────────────
const state: { projects: any[]; milestones: any[]; audit: any[]; insertError: any; notified: any[] } =
  { projects: [], milestones: [], audit: [], insertError: null, notified: [] }

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/utils/cron-alert', () => ({ alertCronFailure: vi.fn(async () => {}) }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: vi.fn(async (_s: any, p: any) => { state.notified.push(p) }) }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: vi.fn(async () => []) }))
vi.mock('@/lib/email/templates', () => ({ sendRetainerEndingEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/utils/audit', () => ({ insertAuditRow: vi.fn(async (_s: any, row: any) => { state.audit.push(row); return true }) }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const filters: Record<string, any> = {}
      let lo = 0, hi = Infinity
      const b: any = {
        select: () => b, not: () => b, is: () => b, order: () => b, limit: () => b,
        eq: (c: string, v: any) => { filters[c] = v; return b },
        range: (a: number, z: number) => { lo = a; hi = z; return b },
        maybeSingle: async () => {
          if (table !== 'audit_log') return { data: null, error: null }
          const hit = state.audit.find(r => r.event_type === filters.event_type && r.entity_id === filters.entity_id
            && String(r.metadata?.duration_months) === filters['metadata->>duration_months'])
          return { data: hit ? { id: 'x' } : null, error: null }
        },
        insert: async (row: any) => {
          if (state.insertError) return { error: state.insertError }
          state.milestones.push(row); return { error: null }
        },
        then: (res: any) => {
          const rows = table === 'projects' ? state.projects
            : table === 'payment_milestones' ? state.milestones.filter(m => m.project_id === filters.project_id) : []
          return res({ data: rows.slice(lo, hi + 1), error: null })
        },
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/cron/retainer-milestones/route'

const project = (over: any = {}) => ({
  id: 'p1', workspace_id: 'w1', name: 'Acme retainer', contract_value: 5000, currency: 'USD',
  retainer_duration_months: 12, clients: { name: 'Acme' },
  sow_documents: [{ id: 's1', status: 'signed', signed_at: '2026-01-20T10:00:00Z' }], ...over,
})
const call = async () => (await POST({} as any)).json()

beforeEach(() => { vi.useFakeTimers(); state.projects = []; state.milestones = []; state.audit = []; state.insertError = null; state.notified = [] })
afterEach(() => vi.useRealTimers())

describe('retainer-milestones cron', () => {
  it("counts the signing-month row (stamped with the signing DAY) as that month — no second row for January", async () => {
    vi.setSystemTime(new Date('2026-03-05T06:00:00Z'))
    state.projects = [project()]
    state.milestones = [{ project_id: 'p1', type: 'retainer_monthly', due_date: '2026-01-20' }] // what the sign route now writes
    const out = await call()
    const months = state.milestones.slice(1).map(m => m.due_date)
    expect(months).toEqual(['2026-02-01', '2026-03-01'])
    expect(out.generated).toBe(2)
  })

  it('is idempotent: a second run the same day generates nothing', async () => {
    vi.setSystemTime(new Date('2026-03-05T06:00:00Z'))
    state.projects = [project()]
    await call()
    const n = state.milestones.length
    const again = await call()
    expect(state.milestones.length).toBe(n)
    expect(again.generated).toBe(0)
  })

  it('BACKFILLS the final months before announcing the end (the old code skipped them)', async () => {
    vi.setSystemTime(new Date('2026-02-03T06:00:00Z'))
    state.projects = [project({ sow_documents: [{ id: 's1', status: 'signed', signed_at: '2025-01-10T10:00:00Z' }] })]
    const out = await call()
    expect(out.generated).toBe(12) // Jan..Dec 2025, none created before
    expect(out.endedNotified).toBe(1)
    expect(state.notified).toHaveLength(1)
  })

  it('announces the end once per TERM LENGTH — an extended retainer that ends again is announced again', async () => {
    vi.setSystemTime(new Date('2026-02-03T06:00:00Z'))
    state.projects = [project({ sow_documents: [{ id: 's1', status: 'signed', signed_at: '2025-01-10T10:00:00Z' }] })]
    await call(); await call()
    expect(state.notified).toHaveLength(1) // same term: not repeated
    state.projects = [project({ retainer_duration_months: 13, sow_documents: [{ id: 's1', status: 'signed', signed_at: '2025-01-10T10:00:00Z' }] })]
    vi.setSystemTime(new Date('2026-03-03T06:00:00Z'))
    const out = await call()
    expect(out.endedNotified).toBe(1)
    expect(state.notified).toHaveLength(2)
  })

  it('does not write a "generated" audit row when the insert fails', async () => {
    vi.setSystemTime(new Date('2026-03-05T06:00:00Z'))
    state.projects = [project()]
    state.insertError = { message: 'constraint', code: '23514' }
    const out = await call()
    expect(state.audit.filter(a => a.event_type === 'payment.milestone_generated')).toHaveLength(0)
    expect(out.generated).toBe(0)
  })

  it('treats a unique-violation (another run got there first) as already generated', async () => {
    vi.setSystemTime(new Date('2026-03-05T06:00:00Z'))
    state.projects = [project()]
    state.insertError = { message: 'duplicate', code: '23505' }
    const out = await call()
    expect(out.generated).toBe(0)
    expect(out.ok).toBe(true)
  })

  it('skips zero-value contracts instead of generating zero-dollar milestones', async () => {
    vi.setSystemTime(new Date('2026-03-05T06:00:00Z'))
    state.projects = [project({ contract_value: 0 })]
    const out = await call()
    expect(state.milestones).toHaveLength(0)
    expect(out.skippedNoValue).toBe(1)
  })

  it('OPEN-ENDED retainer (no term): bills the current month, never backfills history, never announces an end', async () => {
    vi.setSystemTime(new Date('2026-03-05T06:00:00Z'))
    // signed in January with no term and nothing ever generated (the old cron skipped these projects entirely)
    state.projects = [project({ retainer_duration_months: null })]
    const out = await call()
    expect(state.milestones.map(m => m.due_date)).toEqual(['2026-03-01'])
    expect(out.generated).toBe(1)
    expect(out.endedNotified).toBe(0)
    expect(state.notified).toHaveLength(0)
    expect(state.audit.find(a => a.event_type === 'payment.milestone_generated')?.metadata).toMatchObject({ open_ended: true, backfilled: false })
  })

  it('open-ended: keeps billing year after year and is idempotent within a month', async () => {
    vi.setSystemTime(new Date('2028-07-02T06:00:00Z'))
    state.projects = [project({ retainer_duration_months: null })]
    await call()
    expect(state.milestones.map(m => m.due_date)).toEqual(['2028-07-01'])
    await call()
    expect(state.milestones).toHaveLength(1)
    vi.setSystemTime(new Date('2028-08-01T06:00:00Z'))
    await call()
    expect(state.milestones.map(m => m.due_date)).toEqual(['2028-07-01', '2028-08-01'])
    expect(state.notified).toHaveLength(0)
  })

  it('open-ended: a retainer signed this month keeps the sign route\'s row and gets no duplicate', async () => {
    vi.setSystemTime(new Date('2026-03-25T06:00:00Z'))
    state.projects = [project({ retainer_duration_months: null, sow_documents: [{ id: 's1', status: 'signed', signed_at: '2026-03-20T10:00:00Z' }] })]
    state.milestones = [{ project_id: 'p1', type: 'retainer_monthly', due_date: '2026-03-20' }]
    const out = await call()
    expect(out.generated).toBe(0)
    expect(state.milestones).toHaveLength(1)
  })
})
