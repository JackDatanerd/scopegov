import { describe, it, expect } from 'vitest'
import { isAttentionWorthy, attentionReason } from '@/lib/utils/attention'

const ws = { proactiveRiskAlertsEnabled: false, currency: 'USD' }
const base: any = {
  id: 'p1', name: 'P', status: 'Active', stallReason: null, contractValue: 1000, currency: 'USD',
  guardianFlags: [], changeOrders: [], sowDocuments: [{ id: 's1', status: 'signed', version: 1 }],
}
const ctx = (over: any) => ({ project: { ...base, ...over }, workspace: ws })

describe('attention', () => {
  it('a clean active project needs no attention', () => {
    expect(isAttentionWorthy(ctx({}))).toBe(false)
  })
  it('an open flag needs attention', () => {
    const c = ctx({ guardianFlags: [{ status: 'open' }] })
    expect(isAttentionWorthy(c)).toBe(true)
    expect(attentionReason(c)).toMatch(/open scope flag/)
  })
  it('a borderline_review flag (waiting on a human) needs attention', () => {
    const c = ctx({ guardianFlags: [{ status: 'borderline_review' }] })
    expect(isAttentionWorthy(c)).toBe(true)
    expect(attentionReason(c)).toMatch(/awaiting your review/)
  })
  it('finished projects never need attention, even with a declined CO', () => {
    for (const status of ['Complete', 'Archived']) {
      const c = ctx({ status, changeOrders: [{ status: 'declined' }], guardianFlags: [{ status: 'open' }] })
      expect(isAttentionWorthy(c)).toBe(false)
      expect(attentionReason(c)).toBeNull()
    }
  })
})
