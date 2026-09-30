import { describe, it, expect } from 'vitest'
import { cancelPaystackSubscription, resumePaystackSubscription, fetchPaystackSubscription } from '@/lib/integrations/paystack'

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

// Billing independent pass 10 — B3: the timeout used to be cleared when the response HEADERS arrived, so a
// connection that sent headers and then stalled on the body was never aborted.
describe('paystackFetch — body read is bounded by the request timeout', () => {
  it('a body that never arrives is aborted and reported as a failed read (not a hang)', async () => {
    const original = globalThis.fetch
    const realSetTimeout = globalThis.setTimeout
    // Shorten only the library's 12s timer so the test does not wait for it.
    globalThis.setTimeout = ((fn: any, ms?: number, ...a: any[]) => realSetTimeout(fn, ms === 12_000 ? 20 : ms, ...a)) as any
    globalThis.fetch = (async (_u: any, init: any) => ({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: () => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))),
    })) as any
    try {
      const r = await fetchPaystackSubscription('SUB_X')
      expect(r.ok).toBe(false)
    } finally { globalThis.fetch = original; globalThis.setTimeout = realSetTimeout }
  })
  it('an ordinary response is passed through unchanged (status, json body)', async () => {
    const r = await withFetch(() => ({ json: { data: { status: 'active', next_payment_date: '2030-01-01T00:00:00.000Z', email_token: 't' } } }),
      () => fetchPaystackSubscription('SUB_X'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sub.status).toBe('active')
  })
})
