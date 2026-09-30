// tests/billing-pass10-period-end.test.ts
//
// Billing independent pass 10 — B1. lib/billing/period-end.ts: an estimate of a cancelling subscription's
// period end from recorded state, used only when Paystack and the event have no future date.

import { describe, it, expect } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'
import { addBillingInterval, estimatePeriodEnd, RENEWAL_LAG_MS } from '@/lib/billing/period-end'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)

describe('addBillingInterval', () => {
  it('adds a calendar month and clamps to the last day of a shorter month', () => {
    expect(iso(addBillingInterval(Date.UTC(2026, 0, 31), 'monthly'))).toBe('2026-02-28T00:00:00.000Z')
    expect(iso(addBillingInterval(Date.UTC(2026, 8, 30, 9), 'monthly'))).toBe('2026-10-30T09:00:00.000Z')
    expect(iso(addBillingInterval(Date.UTC(2026, 11, 31), 'monthly'))).toBe('2027-01-31T00:00:00.000Z')
  })
  it('adds twelve months for annual, including from a leap day', () => {
    expect(iso(addBillingInterval(Date.UTC(2026, 8, 30), 'annual'))).toBe('2027-09-30T00:00:00.000Z')
    expect(iso(addBillingInterval(Date.UTC(2028, 1, 29), 'annual'))).toBe('2029-02-28T00:00:00.000Z')
  })
})

describe('estimatePeriodEnd', () => {
  const db = (rows: any[] = []) => createFakeSupabase({ audit_log: rows }).client
  const input = (over: any = {}) => ({ workspaceId: 'w1', storedEnd: null, interval: 'monthly', graceStartedAt: null, now: NOW, ...over })

  it('rolls a just-elapsed stored date forward one interval (a renewal the webhook has not refreshed yet)', async () => {
    const stored = iso(NOW - 2 * 3_600_000)
    const r = await estimatePeriodEnd(db(), input({ storedEnd: stored }))
    expect(r).toBe(iso(addBillingInterval(NOW - 2 * 3_600_000, 'monthly')))
    expect(Date.parse(r!)).toBeGreaterThan(NOW)
  })
  it('refuses when the stored date lapsed longer ago than the renewal lag (genuinely overdue, not just renewed)', async () => {
    expect(await estimatePeriodEnd(db(), input({ storedEnd: iso(NOW - RENEWAL_LAG_MS - DAY) }))).toBeNull()
  })
  it('refuses while a grace period is running — nothing was just paid', async () => {
    expect(await estimatePeriodEnd(db(), input({ storedEnd: iso(NOW - 3_600_000), graceStartedAt: iso(NOW - DAY) }))).toBeNull()
  })
  it('refuses for an unknown interval, and when the stored date is already usable', async () => {
    expect(await estimatePeriodEnd(db(), input({ storedEnd: iso(NOW - 3_600_000), interval: null }))).toBeNull()
    expect(await estimatePeriodEnd(db(), input({ storedEnd: iso(NOW + 5 * DAY) }))).toBeNull()
  })
  it('with no stored date, anchors on the newest recorded payment (paid_at preferred over created_at)', async () => {
    const paid = NOW - 10 * DAY
    const r = await estimatePeriodEnd(db([
      { workspace_id: 'w1', event_type: 'billing.payment_succeeded', created_at: iso(NOW - 40 * DAY), metadata: { paid_at: iso(NOW - 40 * DAY) } },
      { workspace_id: 'w1', event_type: 'billing.payment_succeeded', created_at: iso(NOW - 10 * DAY + 5_000), metadata: { paid_at: iso(paid) } },
      { workspace_id: 'w2', event_type: 'billing.payment_succeeded', created_at: iso(NOW - DAY), metadata: {} },
    ]), input())
    expect(r).toBe(iso(addBillingInterval(paid, 'monthly')))
  })
  it('with no stored date and no payment on record (or one older than an interval), gives no estimate', async () => {
    expect(await estimatePeriodEnd(db(), input())).toBeNull()
    expect(await estimatePeriodEnd(db([
      { workspace_id: 'w1', event_type: 'billing.payment_succeeded', created_at: iso(NOW - 60 * DAY), metadata: {} },
    ]), input())).toBeNull()
  })
  it('never throws — a failing read is just "no estimate"', async () => {
    const broken = { from: () => { throw new Error('db down') } }
    const spy = console.error; console.error = () => {}
    try { expect(await estimatePeriodEnd(broken, input())).toBeNull() } finally { console.error = spy }
  })
})
