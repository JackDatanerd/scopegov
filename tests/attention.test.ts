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

describe('attention — manual pause', () => {
  const now = Date.parse('2026-09-24T12:00:00Z')
  const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString()
  const paused = (over: any = {}) => ({ now, ...ctx({ status: 'Stalled', stallReason: 'manual', ...over }) })

  it('a manual pause from a few days ago is a decision, not a problem', () => {
    const c = paused({ stalledAt: daysAgo(3) })
    expect(isAttentionWorthy(c)).toBe(false)
    expect(attentionReason(c)).not.toMatch(/pause|stalled/i)
  })
  it('a manual pause nobody has revisited for two weeks is surfaced, with its age', () => {
    const c = paused({ stalledAt: daysAgo(20) })
    expect(isAttentionWorthy(c)).toBe(true)
    expect(attentionReason(c)).toBe('Paused for 20 days')
  })
  it('a recent pause still surfaces other problems (an open flag)', () => {
    const c = paused({ stalledAt: daysAgo(1), guardianFlags: [{ status: 'open' }] })
    expect(isAttentionWorthy(c)).toBe(true)
    expect(attentionReason(c)).toMatch(/open scope flag/)
  })
  it('a pause with no recorded start keeps the old behaviour (surfaced)', () => {
    expect(isAttentionWorthy(paused({ stalledAt: null }))).toBe(true)
  })
  it('an unsigned-SOW stall is never treated as a deliberate pause', () => {
    const c = { now, ...ctx({ status: 'Stalled', stallReason: 'sow_unsigned', stalledAt: daysAgo(1) }) }
    expect(isAttentionWorthy(c)).toBe(true)
    expect(attentionReason(c)).toBe('SOW unsigned — project stalled')
  })

  it('a declined/expired CO that has a sent revision is history, not attention', () => {
    const c = ctx({ changeOrders: [
      { id: 'v1', status: 'declined', parent_co_id: null, sent_at: '2026-08-01T00:00:00Z' },
      { id: 'v2', status: 'accepted', parent_co_id: 'v1', sent_at: '2026-08-10T00:00:00Z' },
    ] })
    expect(isAttentionWorthy(c)).toBe(false)
    expect(attentionReason(c) ?? '').not.toMatch(/change order/i)
  })
  it('an UNSENT draft revision does not retire the declined parent', () => {
    const c = ctx({ changeOrders: [
      { id: 'v1', status: 'declined', parent_co_id: null, sent_at: '2026-08-01T00:00:00Z' },
      { id: 'v2', status: 'draft', parent_co_id: 'v1', sent_at: null },
    ] })
    expect(isAttentionWorthy(c)).toBe(true)
    expect(attentionReason(c)).toBe('Change order declined')
  })
  it('the declined revision itself still surfaces after its parent is retired', () => {
    const c = ctx({ changeOrders: [
      { id: 'v1', status: 'declined', parent_co_id: null, sent_at: '2026-08-01T00:00:00Z' },
      { id: 'v2', status: 'declined', parent_co_id: 'v1', sent_at: '2026-08-10T00:00:00Z' },
    ] })
    expect(isAttentionWorthy(c)).toBe(true)
  })
})
