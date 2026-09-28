import { describe, it, expect } from 'vitest'
import { cancelPaystackSubscription, resumePaystackSubscription } from '@/lib/integrations/paystack'

// Billing re-pass, independent redo #3 — B5 / email-token fallback.
type Call = { url: string; method: string; body: any }
async function withFetch<T>(handler: (c: Call) => { status?: number; json?: any }, run: (calls: Call[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }
    calls.push(call)
    const r = handler(call)
    const status = r.status ?? 200
    return { ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => r.json ?? {}, text: async () => JSON.stringify(r.json ?? {}) } as any
  }) as any
  try { return await run(calls) } finally { globalThis.fetch = original }
}

describe('resumePaystackSubscription', () => {
  it('treats a refusal for an already-ACTIVE subscription as success (no stuck cancels_at_period_end)', async () => {
    const r = await withFetch(c => c.url.endsWith('/subscription/enable')
      ? { status: 400, json: { message: 'Subscription is already active' } }
      : { json: { data: { status: 'active', email_token: 't' } } },
    () => resumePaystackSubscription({ paystack_subscription_code: 'SUB_1', paystack_email_token: 't' }))
    expect(r.ok).toBe(true)
  })
  it('still fails when Paystack refuses and the subscription is not active', async () => {
    const r = await withFetch(c => c.url.endsWith('/subscription/enable')
      ? { status: 400, json: { message: 'nope' } }
      : { json: { data: { status: 'cancelled', email_token: 't' } } },
    () => resumePaystackSubscription({ paystack_subscription_code: 'SUB_1', paystack_email_token: 't' }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('nope')
  })
  it('reads the email token from Paystack when none is on file', async () => {
    const calls = await withFetch(c => c.url.endsWith('/subscription/enable') ? { json: {} } : { json: { data: { status: 'non-renewing', email_token: 'TOK_FETCHED' } } },
      async calls => { await resumePaystackSubscription({ paystack_subscription_code: 'SUB_1', paystack_email_token: null }); return calls })
    const enable = calls.find(c => c.url.endsWith('/subscription/enable'))
    expect(enable?.body).toEqual({ code: 'SUB_1', token: 'TOK_FETCHED' })
  })
})

describe('cancelPaystackSubscription', () => {
  it('reads the email token from Paystack when none is on file (was a permanent 502)', async () => {
    const r = await withFetch(c => c.url.endsWith('/subscription/disable') ? { json: {} } : { json: { data: { status: 'active', email_token: 'TOK_FETCHED' } } },
      async calls => { const res = await cancelPaystackSubscription({ paystack_subscription_code: 'SUB_1', paystack_email_token: null }); return { res, calls } })
    expect(r.res.ok).toBe(true)
    expect(r.calls.find(c => c.url.endsWith('/subscription/disable'))?.body).toEqual({ code: 'SUB_1', token: 'TOK_FETCHED' })
  })
  it('does not call Paystack for the token when one is on file', async () => {
    const calls = await withFetch(() => ({ json: {} }),
      async calls => { await cancelPaystackSubscription({ paystack_subscription_code: 'SUB_1', paystack_email_token: 'T' }); return calls })
    expect(calls.length).toBe(1)
  })
  it('a subscription Paystack no longer knows counts as already gone', async () => {
    const r = await withFetch(() => ({ status: 404, json: { message: 'Subscription not found' } }),
      () => cancelPaystackSubscription({ paystack_subscription_code: 'SUB_1', paystack_email_token: null }))
    expect(r).toEqual({ ok: true, alreadyCancelled: true })
  })
  it('fails (does not pretend success) when the token cannot be obtained', async () => {
    const r = await withFetch(() => ({ status: 500, json: {} }),
      () => cancelPaystackSubscription({ paystack_subscription_code: 'SUB_1', paystack_email_token: null }))
    expect(r.ok).toBe(false)
  })
})
