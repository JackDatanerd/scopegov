import { describe, it, expect } from 'vitest'
import { parsePlanRequest, planCodeFor, planCodeToTier, planCodeToInterval, fromSubunit, PAID_PLAN_KEYS } from '@/lib/billing/plans'
import { claimWebhookEvent, completeWebhookEvent, releaseWebhookEvent, STALE_CLAIM_MS } from '@/lib/billing/webhook-claims'
import { findPendingCheckout, CHECKOUT_TTL_MS } from '@/lib/billing/checkouts'
import { resolveWorkspace } from '@/lib/billing/resolve'

// ── a tiny in-memory PostgREST-shaped fake ───────────────────────────────
type Row = Record<string, any>
function fakeService(tables: Record<string, Row[]>, uniqueKeys: Record<string, string> = {}) {
  const from = (table: string) => {
    tables[table] = tables[table] || []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: any = null
    let returning = false
    let wantSingle = false
    let limitN: number | null = null
    const filters: Array<(r: Row) => boolean> = []
    const orders: Array<{ col: string; asc: boolean }> = []
    const b: any = {
      select() { returning = true; return b },
      insert(v: Row) { op = 'insert'; payload = v; return b },
      update(v: Row) { op = 'update'; payload = v; returning = false; return b },
      delete() { op = 'delete'; return b },
      eq(c: string, v: any) { filters.push(r => r[c] === v); return b },
      is(c: string, v: any) { filters.push(r => (r[c] ?? null) === v); return b },
      gte(c: string, v: any) { filters.push(r => r[c] >= v); return b },
      order(c: string, o?: { ascending?: boolean }) { orders.push({ col: c, asc: o?.ascending !== false }); return b },
      limit(n: number) { limitN = n; return b },
      maybeSingle() { wantSingle = true; return b },
      then(resolve: any, reject: any) {
        try {
          const rows = tables[table]
          if (op === 'insert') {
            const uk = uniqueKeys[table]
            if (uk && rows.some(r => r[uk] === payload[uk])) return resolve({ data: null, error: { code: '23505', message: 'duplicate' } })
            rows.push({ ...payload }); return resolve({ data: null, error: null })
          }
          let matched = rows.filter(r => filters.every(f => f(r)))
          if (op === 'update') {
            matched.forEach(r => Object.assign(r, payload))
            return resolve({ data: returning ? matched.map(r => ({ ...r })) : null, error: null })
          }
          if (op === 'delete') {
            tables[table] = rows.filter(r => !matched.includes(r))
            return resolve({ data: null, error: null })
          }
          for (const o of [...orders].reverse()) matched = [...matched].sort((a, c) => (a[o.col] > c[o.col] ? 1 : -1) * (o.asc ? 1 : -1))
          if (limitN != null) matched = matched.slice(0, limitN)
          return resolve({ data: wantSingle ? (matched[0] ?? null) : matched, error: null })
        } catch (e) { return reject(e) }
      },
    }
    return b
  }
  return { from }
}

describe('parsePlanRequest', () => {
  it('normalises case so plan-limit lookups can never be skipped', () => {
    const r = parsePlanRequest('SOLO', 'MONTHLY')
    expect(r).toMatchObject({ ok: true, planKey: 'solo', interval: 'monthly', envKey: 'PAYSTACK_PLAN_SOLO_MONTHLY' })
    expect(parsePlanRequest(' Pro ', undefined)).toMatchObject({ ok: true, planKey: 'pro', interval: 'monthly' })
  })
  it('rejects unknown, trial and non-string input without throwing', () => {
    for (const bad of [undefined, null, 5, {}, '', 'trial', 'enterprise', 'constructor', '__proto__']) {
      expect(parsePlanRequest(bad as any, 'monthly').ok).toBe(false)
    }
    expect(parsePlanRequest('solo', 'weekly').ok).toBe(false)
    expect(parsePlanRequest('solo', 5 as any).ok).toBe(false)
    expect(parsePlanRequest('solo', {} as any).ok).toBe(false)
  })
})

describe('plan code mapping', () => {
  const env: any = {
    PAYSTACK_PLAN_SOLO_MONTHLY: 'PLN_sm', PAYSTACK_PLAN_SOLO_ANNUAL: 'PLN_sa',
    PAYSTACK_PLAN_PRO_MONTHLY: 'PLN_pm', // pro annual + others deliberately unset
  }
  it('maps codes to tier and interval', () => {
    expect(planCodeToTier('PLN_sm', env)).toBe('solo')
    expect(planCodeToInterval('PLN_sa', env)).toBe('annual')
    expect(planCodeToTier('PLN_pm', env)).toBe('pro')
    expect(planCodeFor('pro', 'annual', env)).toBeNull()
  })
  it('never resolves an empty or unknown code (unset env vars must not collapse to "")', () => {
    expect(planCodeToTier('', env)).toBeNull()
    expect(planCodeToTier(undefined, env)).toBeNull()
    expect(planCodeToTier('PLN_nope', env)).toBeNull()
    expect(planCodeToInterval(null, env)).toBeNull()
  })
  it('covers every paid tier', () => {
    expect([...PAID_PLAN_KEYS]).toEqual(['solo', 'starter', 'pro', 'agency'])
  })
  it('converts Paystack subunits', () => {
    expect(fromSubunit(2500)).toBe(25)
    expect(fromSubunit('x')).toBeUndefined()
  })
})

describe('webhook claims', () => {
  const KEY = 'charge.success:abc'
  it('claims once, then reports an in-flight duplicate', async () => {
    const svc = fakeService({ processed_webhook_events: [] }, { processed_webhook_events: 'idempotency_key' })
    expect((await claimWebhookEvent(svc, KEY, 1_000)).status).toBe('claimed')
    expect((await claimWebhookEvent(svc, KEY, 1_500)).status).toBe('in_progress')
  })
  it('a FAILED attempt releases the claim so the retry re-runs (the lost-payment bug)', async () => {
    const svc = fakeService({ processed_webhook_events: [] }, { processed_webhook_events: 'idempotency_key' })
    const first = await claimWebhookEvent(svc, KEY, 1_000)
    expect(first.status).toBe('claimed')
    await releaseWebhookEvent(svc, KEY, first.claimedAt!)
    expect((await claimWebhookEvent(svc, KEY, 2_000)).status).toBe('claimed')
  })
  it('a COMPLETED event is a duplicate on redelivery', async () => {
    const svc = fakeService({ processed_webhook_events: [] }, { processed_webhook_events: 'idempotency_key' })
    const first = await claimWebhookEvent(svc, KEY, 1_000)
    await completeWebhookEvent(svc, KEY, first.claimedAt!)
    expect((await claimWebhookEvent(svc, KEY, 9_000)).status).toBe('duplicate')
    // a release must never delete a finished event
    await releaseWebhookEvent(svc, KEY, first.claimedAt!)
    expect((await claimWebhookEvent(svc, KEY, 9_500)).status).toBe('duplicate')
  })
  it('takes over a claim left behind by a crashed attempt once it is stale', async () => {
    const svc = fakeService({ processed_webhook_events: [] }, { processed_webhook_events: 'idempotency_key' })
    await claimWebhookEvent(svc, KEY, 1_000)
    expect((await claimWebhookEvent(svc, KEY, 1_000 + STALE_CLAIM_MS - 1)).status).toBe('in_progress')
    expect((await claimWebhookEvent(svc, KEY, 1_000 + STALE_CLAIM_MS + 1)).status).toBe('claimed')
  })
  // FIX (deep audit, Billing re-pass — independent redo): regression test for
  // the ownership-check fix above. Without it, the ORIGINAL (stale, but not
  // actually dead) attempt's release/complete would act on whatever row
  // currently sits at that idempotency_key — including one a takeover retry
  // has since claimed — either deleting the new owner's live claim or
  // stamping it 'done' out from under it.
  it('a stale-but-still-alive attempt can no longer release or complete a claim a retry has since taken over', async () => {
    const svc = fakeService({ processed_webhook_events: [] }, { processed_webhook_events: 'idempotency_key' })
    const original = await claimWebhookEvent(svc, KEY, 1_000)
    expect(original.status).toBe('claimed')
    // A retry sees the claim as stale and takes it over.
    const takeover = await claimWebhookEvent(svc, KEY, 1_000 + STALE_CLAIM_MS + 1)
    expect(takeover.status).toBe('claimed')
    expect(takeover.claimedAt).not.toBe(original.claimedAt)
    // The original attempt was slow, not dead — it now finally fails and
    // tries to release ITS OWN (stale) claimedAt. This must not touch the
    // takeover's live claim.
    await releaseWebhookEvent(svc, KEY, original.claimedAt!)
    expect((await claimWebhookEvent(svc, KEY, 1_000 + STALE_CLAIM_MS + 2)).status).toBe('in_progress')
    // Nor may the original attempt's eventual success mark the takeover's
    // claim done out from under it.
    await completeWebhookEvent(svc, KEY, original.claimedAt!)
    expect((await claimWebhookEvent(svc, KEY, 1_000 + STALE_CLAIM_MS + 3)).status).toBe('in_progress')
    // The real (takeover) owner can still complete its own claim normally.
    await completeWebhookEvent(svc, KEY, takeover.claimedAt!)
    expect((await claimWebhookEvent(svc, KEY, 1_000 + STALE_CLAIM_MS + 4)).status).toBe('duplicate')
  })
})

describe('pending checkouts', () => {
  const now = Date.parse('2026-09-19T12:00:00Z')
  const rows = () => ({
    billing_checkouts: [
      { id: 'c1', workspace_id: 'wsA', email: 'owner@x.com', plan_code: 'PLN_1', consumed_at: null, created_at: new Date(now - 60_000).toISOString() },
      { id: 'c2', workspace_id: 'wsB', email: 'owner@x.com', plan_code: 'PLN_1', consumed_at: null, created_at: new Date(now - 120_000).toISOString() },
      { id: 'old', workspace_id: 'wsC', email: 'owner@x.com', plan_code: 'PLN_1', consumed_at: null, created_at: new Date(now - CHECKOUT_TTL_MS - 1000).toISOString() },
      { id: 'used', workspace_id: 'wsD', email: 'owner@x.com', plan_code: 'PLN_1', consumed_at: 'x', created_at: new Date(now - 1000).toISOString() },
    ],
  })
  it('matches case-insensitively and prefers the newest', async () => {
    const c = await findPendingCheckout(fakeService(rows()), 'OWNER@X.com', 'PLN_1', undefined, now)
    expect(c?.id).toBe('c1')
  })
  it('uses the browser hint only to choose among server-recorded candidates', async () => {
    expect((await findPendingCheckout(fakeService(rows()), 'owner@x.com', 'PLN_1', 'wsB', now))?.workspace_id).toBe('wsB')
  })
  it('CANNOT be pointed at a workspace that has no server-recorded checkout', async () => {
    const c = await findPendingCheckout(fakeService(rows()), 'owner@x.com', 'PLN_1', 'victimWorkspace', now)
    expect(c?.workspace_id).toBe('wsA')
    expect(c?.workspace_id).not.toBe('victimWorkspace')
  })
  it('ignores expired and consumed checkouts and other plans/emails', async () => {
    expect(await findPendingCheckout(fakeService(rows()), 'owner@x.com', 'PLN_other', undefined, now)).toBeNull()
    expect(await findPendingCheckout(fakeService(rows()), 'someone@else.com', 'PLN_1', undefined, now)).toBeNull()
  })
})

describe('resolveWorkspace', () => {
  const billingRow = (o: Row) => ({
    paystack_email_token: null, current_period_end: null, cancels_at_period_end: false, grace_period_started_at: null, ...o,
  })
  it('finds the workspace by subscription code, ignoring the payer\'s "active workspace"', async () => {
    const svc = fakeService({ billing: [billingRow({ workspace_id: 'wsPaid', paystack_subscription_code: 'SUB_1', paystack_customer_code: 'CUS_1' })] })
    const r = await resolveWorkspace(svc, { subscription_code: 'SUB_1', customer: { email: 'a@b.com', customer_code: 'CUS_1' } })
    expect(r).toMatchObject({ workspaceId: 'wsPaid', via: 'subscription_code', superseded: false })
  })
  it('reads the subscription code from an invoice payload too', async () => {
    const svc = fakeService({ billing: [billingRow({ workspace_id: 'wsPaid', paystack_subscription_code: 'SUB_1', paystack_customer_code: 'CUS_1' })] })
    const r = await resolveWorkspace(svc, { subscription: { subscription_code: 'SUB_1' }, customer: { customer_code: 'CUS_1' } })
    expect(r.workspaceId).toBe('wsPaid')
  })
  it('falls back to a unique customer code and flags a superseded subscription', async () => {
    const svc = fakeService({ billing: [billingRow({ workspace_id: 'ws1', paystack_subscription_code: 'SUB_NEW', paystack_customer_code: 'CUS_1' })] })
    const r = await resolveWorkspace(svc, { subscription_code: 'SUB_OLD', customer: { customer_code: 'CUS_1' } })
    expect(r).toMatchObject({ workspaceId: 'ws1', via: 'customer_code', superseded: true })
  })
  it('refuses to guess when one customer code maps to several workspaces', async () => {
    const svc = fakeService({ billing: [
      billingRow({ workspace_id: 'ws1', paystack_subscription_code: 'S1', paystack_customer_code: 'CUS_1' }),
      billingRow({ workspace_id: 'ws2', paystack_subscription_code: 'S2', paystack_customer_code: 'CUS_1' }),
    ] })
    const r = await resolveWorkspace(svc, { customer: { customer_code: 'CUS_1' } })
    expect(r.workspaceId).toBeNull()
    expect(r.ambiguous).toBe(true)
  })
  it('subscription.create binds ONLY to a server-recorded checkout (strict), never to a customer-code row', async () => {
    const svc = fakeService({
      billing: [billingRow({ workspace_id: 'wsOther', paystack_subscription_code: 'S_OLD', paystack_customer_code: 'CUS_1' })],
      billing_checkouts: [],
    })
    const r = await resolveWorkspace(svc, {
      subscription_code: 'S_NEW', customer: { email: 'a@b.com', customer_code: 'CUS_1' }, plan: { plan_code: 'PLN_1' },
      metadata: { workspaceId: 'wsOther' },
    }, { checkout: 'strict', planCode: 'PLN_1' })
    expect(r.workspaceId).toBeNull()
  })
})
