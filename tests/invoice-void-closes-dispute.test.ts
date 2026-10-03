import { describe, it, expect, vi, beforeEach } from 'vitest'

const state: { updates: any[]; invoice: any } = { updates: [], invoice: null }

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', name: 'A', workspaceId: 'w1' })),
  hasPermission: vi.fn(() => true),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: vi.fn(async () => {}) }))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: vi.fn(async () => true) }))
vi.mock('@/lib/approvals/engine', () => ({ cancelApprovalRequest: vi.fn(async () => ({})) }))
vi.mock('@/lib/email/reply-to', () => ({ resolveReplyTo: vi.fn(async () => undefined) }))
vi.mock('@/lib/email/templates', () => ({ sendDocumentCancelledEmail: vi.fn(async () => ({})) }))
vi.mock('@/lib/email/delivery', () => ({ checkedSend: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/utils/client-contacts', () => ({ withPrimaryContactCc: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      let mode: 'select' | 'update' | 'insert' = 'select'
      const b: any = {
        select: () => b,
        update: (v: any) => { mode = 'update'; if (table === 'invoices') state.updates.push(v); return b },
        insert: () => { mode = 'insert'; return b },
        eq: () => b, neq: () => b, in: () => b, limit: () => b,
        single: async () => ({ data: table === 'invoices' ? state.invoice : null }),
        maybeSingle: async () => ({ data: mode === 'update' ? { id: 'inv1' } : null, error: null }),
        then: (res: any) => res({ data: [], error: null }),
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/invoices/[id]/void/route'

const call = () => POST(
  new Request('http://x/api/invoices/inv1/void', { method: 'POST', body: JSON.stringify({}) }) as any,
  { params: Promise.resolve({ id: 'inv1' }) },
)
const base = { id: 'inv1', title: 'T', status: 'sent', amount: 100, amount_paid: 0, currency: 'USD', token: null, milestone_id: null, project_id: 'p1', sent_at: null, projects: null }

describe('void invoice closes an open dispute', () => {
  beforeEach(() => { state.updates = [] })

  it('stamps the dispute resolved in the same write when one is open', async () => {
    state.invoice = { ...base, disputed_at: '2026-10-01T00:00:00Z', dispute_resolved_at: null }
    const res = await call()
    expect(res.status).toBe(200)
    expect(state.updates[0]).toMatchObject({ status: 'void', dispute_resolution_note: 'Invoice voided', dispute_resolved_by: 'u1' })
    expect(state.updates[0].dispute_resolved_at).toBeTruthy()
  })

  it('leaves dispute columns alone when there is no open dispute', async () => {
    state.invoice = { ...base, disputed_at: null, dispute_resolved_at: null }
    await call()
    expect(state.updates[0]).not.toHaveProperty('dispute_resolved_at')
    state.updates = []
    state.invoice = { ...base, disputed_at: '2026-10-01T00:00:00Z', dispute_resolved_at: '2026-10-02T00:00:00Z' }
    await call()
    expect(state.updates[0]).not.toHaveProperty('dispute_resolved_at')
  })
})
