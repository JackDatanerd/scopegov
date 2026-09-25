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
})
