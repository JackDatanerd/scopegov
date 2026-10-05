import { describe, it, expect, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

// Projects & Dashboard — fresh independent pass regressions.

const h = vi.hoisted(() => ({ db: null as any }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'a@b.co', name: 'A', workspaceId: 'w1', planTier: 'pro', permissions: [] }),
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/approvals/engine', () => ({
  cancelApprovalRequest: async () => {}, projectApprovalSendInFlight: async () => false, SEND_IN_FLIGHT_MESSAGE: 'x',
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))

import { POST as complete } from '@/app/api/projects/[id]/complete/route'
import { parseContractValue, parseStartDate } from '@/lib/utils/project-input'
import { displayToTokens } from '@/lib/utils/project-messages'

const run = (cos: any[]) => {
  h.db = createFakeSupabase({
    projects: [{ id: '11111111-1111-1111-1111-111111111111', workspace_id: 'w1', name: 'Site', status: 'Active', deleted_at: null, change_orders: cos, guardian_flags: [] }],
    approval_requests: [],
  })
  return complete({} as any, { params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }) })
}

describe('complete route: superseded change orders are history, not blockers', () => {
  const v1 = { id: 'co1', title: 'v1', status: 'expired', parent_co_id: null, sent_at: '2026-08-01T00:00:00Z' }
  const v2 = { id: 'co2', title: 'v2', status: 'accepted', parent_co_id: 'co1', sent_at: '2026-08-10T00:00:00Z' }
  it('expired v1 revised into accepted v2 does not block', async () => {
    expect((await run([v1, v2])).status).toBe(200)
  })
  it('a lone expired CO still blocks', async () => {
    const res = await run([v1])
    expect(res.status).toBe(409)
  })
  it('an UNSENT revision does not supersede its parent', async () => {
    const res = await run([v1, { ...v2, status: 'draft', sent_at: null }])
    expect(res.status).toBe(409)
  })
  it('a live v2 awaiting response still blocks', async () => {
    const res = await run([v1, { ...v2, status: 'awaiting_response' }])
    expect(res.status).toBe(409)
    expect((await res.json()).blockingCos.map((c: any) => c.id)).toEqual(['co2'])
  })
})

describe('parseContractValue: commas are thousands separators only', () => {
  it.each([['1,234', 1234], ['1,234,567.50', 1234567.5], ['12,500.50', 12500.5], ['1,50,000', 150000], ['12,34,567', 1234567], ['1500', 1500], ['0.5', 0.5]])('accepts %s', (raw, want) => {
    expect(parseContractValue(raw)).toEqual({ ok: true, value: want })
  })
  it.each(['1,5', '1.500,50', '2.500,00', '12,34,56', '1,2,3,4', '1,,5', '1,23', ',500', '1,234,'])('rejects %s', raw => {
    expect(parseContractValue(raw).ok).toBe(false)
  })
  it('still reports negatives as negative', () => {
    expect(parseContractValue('-5')).toEqual({ ok: false, error: 'Contract value cannot be negative' })
    expect(parseContractValue('-1,234')).toEqual({ ok: false, error: 'Contract value cannot be negative' })
  })
})

describe('parseStartDate: bounds', () => {
  it.each(['0000-01-01', '1899-12-31', '2101-01-01'])('rejects %s', d => expect(parseStartDate(d).ok).toBe(false))
  it.each(['1900-01-01', '2026-09-30', '2100-12-31'])('accepts %s', d => expect(parseStartDate(d)).toEqual({ ok: true, value: d }))
})

describe('displayToTokens: left boundary', () => {
  const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  it('leaves email addresses alone', () => {
    expect(displayToTokens('mail bob@Ann.com', { Ann: A })).toBe('mail bob@Ann.com')
  })
  it('still converts mentions at start, after space, punctuation and adjacent mentions', () => {
    const p = { Ann: A, Bo: B }
    expect(displayToTokens('@Ann hi', p)).toBe(`@[Ann](${A}) hi`)
    expect(displayToTokens('hi (@Ann), @Bo', p)).toBe(`hi (@[Ann](${A})), @[Bo](${B})`)
    expect(displayToTokens('@Ann @Bo', p)).toBe(`@[Ann](${A}) @[Bo](${B})`)
    expect(displayToTokens('line\n@Bo', p)).toBe(`line\n@[Bo](${B})`)
  })
  it('longest name still wins', () => {
    expect(displayToTokens('@Ann Lee and @Ann', { Ann: A, 'Ann Lee': B })).toBe(`@[Ann Lee](${B}) and @[Ann](${A})`)
  })
})
