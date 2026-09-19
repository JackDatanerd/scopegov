// lib/integrations/paystack.ts
//
// FIX (section-by-section re-audit, Workspace lifecycle Finding 1 —
// CRITICAL): app/api/workspace/delete/route.ts soft-deleted a workspace
// and deactivated every membership without ever touching
// billing.paystack_subscription_code — the Paystack subscription kept
// renewing and charging the customer's card indefinitely, with no
// workspace left to show for it and no UI surface left to cancel from
// (the cancel button lives inside the now-inaccessible workspace's
// settings). Extracted from app/api/billing/cancel/route.ts's existing,
// working cancellation call so both routes share one implementation
// instead of drifting.
//
// FIX (audit round 6, Billing deep-dive): this used to return void and
// swallow every failure into a console.error, with both callers
// (billing/cancel and workspace/delete) proceeding unconditionally
// afterwards. That's the right call for workspace/delete — you don't want
// to block someone from deleting their workspace because Paystack is
// briefly unreachable, and the failure is still logged so it isn't lost.
// But billing/cancel is the user-facing "cancel my subscription" button,
// and swallowing the failure there meant a customer could be told
// cancellation succeeded while the real Paystack subscription kept
// renewing and would charge their card again — with cancels_at_period_end
// then set locally, blocking any retry through the UI ("already scheduled
// for cancellation"). Return a real result so each caller can decide what
// "best-effort" means for its own situation, instead of hiding the
// outcome from both of them equally.

// FIX (Billing re-pass #3): none of the Paystack calls in this file had a
// timeout, so a hung connection held the serverless function open until the
// platform killed it — mid-webhook, that means a half-applied payment event.
const PAYSTACK_TIMEOUT_MS = 12_000

async function paystackFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PAYSTACK_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export interface PaystackSubscriptionInfo {
  status: string | null            // active | non-renewing | attention | completed | cancelled
  nextPaymentDate: string | null
  planCode: string | null
  customerCode: string | null
}

/** null = could not be read (network/5xx); { notFound: true } = Paystack says it doesn't exist. */
export async function fetchPaystackSubscription(
  subscriptionCode: string,
): Promise<{ ok: true; sub: PaystackSubscriptionInfo } | { ok: false; notFound: boolean; error: string }> {
  try {
    const resp = await paystackFetch(`https://api.paystack.co/subscription/${encodeURIComponent(subscriptionCode)}`, {
      headers: { 'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText)
      return { ok: false, notFound: resp.status === 404, error: text }
    }
    const body = await resp.json().catch(() => null)
    const d = body?.data
    if (!d) return { ok: false, notFound: false, error: 'Empty response from Paystack' }
    return {
      ok: true,
      sub: {
        status: d.status ?? null,
        nextPaymentDate: d.next_payment_date ?? null,
        planCode: d.plan?.plan_code ?? null,
        customerCode: d.customer?.customer_code ?? null,
      },
    }
  } catch (e) {
    return { ok: false, notFound: false, error: e instanceof Error ? e.message : 'Could not reach Paystack' }
  }
}

export interface CancelPaystackResult {
  ok: boolean
  alreadyCancelled: boolean
  error?: string
}

// FIX (re-audit, Billing section): billing.current_period_end was only ever
// set once, in the subscription.create webhook handler, and never refreshed
// on renewal. The webhook doesn't handle invoice.create/invoice.update (the
// events Paystack's own docs say carry the fresh per-cycle date), so
// charge.success — the one renewal event this app already handles — calls
// this to pull the current next_payment_date straight from the
// Subscription resource instead. Same field name (next_payment_date) this
// codebase already trusts from the subscription.create webhook payload,
// just read from the Fetch Subscription API instead of a webhook body.
export async function fetchPaystackNextPaymentDate(subscriptionCode: string): Promise<string | null> {
  const res = await fetchPaystackSubscription(subscriptionCode)
  if (!res.ok) {
    console.error('Paystack fetch-subscription error:', res.error)
    return null
  }
  return res.sub.nextPaymentDate
}

// FEATURE (build, Billing re-pass): cancels_at_period_end exists precisely
// so a customer keeps access (and the option to change their mind) until
// the period they already paid for runs out — but nothing anywhere let
// them actually change their mind. Paystack's subscription/enable
// endpoint is the exact mirror of subscription/disable below, so this is
// the same call shape as cancelPaystackSubscription, just the other verb.
export interface ResumePaystackResult {
  ok: boolean
  error?: string
}

export async function resumePaystackSubscription(billing: {
  paystack_subscription_code?: string | null
  paystack_email_token?: string | null
} | null | undefined): Promise<ResumePaystackResult> {
  if (!billing?.paystack_subscription_code) return { ok: false, error: 'No subscription on file to resume' }

  try {
    const resp = await paystackFetch('https://api.paystack.co/subscription/enable', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        code:  billing.paystack_subscription_code,
        token: billing.paystack_email_token,
      }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      console.error('Paystack enable error:', err)
      return { ok: false, error: err.message || 'Paystack declined the resume request' }
    }
    return { ok: true }
  } catch (e) {
    console.error('Paystack enable call failed:', e)
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach Paystack' }
  }
}

export async function cancelPaystackSubscription(billing: {
  paystack_subscription_code?: string | null
  paystack_email_token?: string | null
} | null | undefined): Promise<CancelPaystackResult> {
  if (!billing?.paystack_subscription_code) return { ok: true, alreadyCancelled: true } // nothing to cancel

  try {
    const resp = await paystackFetch('https://api.paystack.co/subscription/disable', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        code:  billing.paystack_subscription_code,
        token: billing.paystack_email_token,
      }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      // Case-insensitive, and "not found" counts as gone too: Paystack no
      // longer knowing the subscription means there is nothing left that can
      // charge the customer, which is the outcome every caller wants.
      if (/already|non-renewing|not found|does not exist/i.test(String(err.message || ''))) {
        return { ok: true, alreadyCancelled: true }
      }
      console.error('Paystack disable error:', err)
      return { ok: false, alreadyCancelled: false, error: err.message || 'Paystack declined the cancellation request' }
    }
    return { ok: true, alreadyCancelled: false }
  } catch (e) {
    // Logged either way so a failure is never silently lost — callers
    // decide separately whether to also block on it (see billing/cancel
    // vs workspace/delete for the two different answers to that).
    console.error('Paystack disable call failed:', e)
    return { ok: false, alreadyCancelled: false, error: e instanceof Error ? e.message : 'Could not reach Paystack' }
  }
}
