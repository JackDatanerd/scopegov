// lib/billing/period-end.ts
//
// FIX (Billing independent pass 10 — B1): billing/cancel and the webhook's subscription.disable /
// subscription.not_renew handler both try to give a cancellation a usable current_period_end before
// flagging cancels_at_period_end (cron/payment-overdue step 5 only ever selects cancelling rows whose period
// end is NOT NULL and already in the past). Both took the date from the event or from Paystack's Fetch
// Subscription API — and when neither had a future date (Paystack can still show the date that JUST elapsed
// right after a renewal, and a disabled subscription reports none at all) they wrote the flag anyway and left
// the old value:
//   - an elapsed date  -> step 5 downgraded a customer who had just paid for another period, next morning;
//   - a missing date   -> step 5 never selected the row: a paid plan kept indefinitely after cancelling.
// This is the third source, used only when the first two come up empty: an ESTIMATE from what this app itself
// recorded. It never guesses when the payment state is doubtful (a grace period is running, or the stored date
// lapsed long ago), because then nothing was "just paid" and ending the plan promptly is the correct outcome.

export const RENEWAL_LAG_MS = 3 * 86_400_000

type Interval = 'monthly' | 'annual'

const isInterval = (v: unknown): v is Interval => v === 'monthly' || v === 'annual'

/** `ms` + one billing interval, calendar-aware (UTC) and clamped to the target month's last day. */
export function addBillingInterval(ms: number, interval: Interval): number {
  const d = new Date(ms)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + (interval === 'annual' ? 12 : 1))
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d.getTime()
}

export interface PeriodEndInput {
  workspaceId: string
  storedEnd: string | null | undefined
  interval: string | null | undefined
  graceStartedAt: string | null | undefined
  now?: number
}

/**
 * A future period end derived from recorded state, or null when there is no safe estimate.
 * Never throws: every failure path answers null (the caller then keeps its existing behaviour).
 */
export async function estimatePeriodEnd(service: any, input: PeriodEndInput): Promise<string | null> {
  try {
    const now = input.now ?? Date.now()
    // A failing payment means nothing was just paid for.
    if (input.graceStartedAt) return null
    if (!isInterval(input.interval)) return null

    const storedMs = input.storedEnd ? Date.parse(input.storedEnd) : NaN
    if (!isNaN(storedMs)) {
      if (storedMs > now) return null // already usable — nothing to estimate
      // A renewal that has not reached us yet: the stored date is only just behind. Anything older is a
      // subscription that is genuinely overdue, not one that just renewed.
      if (now - storedMs > RENEWAL_LAG_MS) return null
      const next = addBillingInterval(storedMs, input.interval)
      return next > now ? new Date(next).toISOString() : null
    }

    // No stored date at all: anchor on the newest payment this app recorded for the workspace.
    const { data, error } = await service.from('audit_log')
      .select('created_at, metadata')
      .eq('workspace_id', input.workspaceId).eq('event_type', 'billing.payment_succeeded')
      .order('created_at', { ascending: false }).limit(1)
    if (error || !data || data.length === 0) return null
    const row = data[0]
    const paid = Date.parse(row?.metadata?.paid_at ?? '')
    const base = !isNaN(paid) ? paid : Date.parse(row?.created_at ?? '')
    if (isNaN(base)) return null
    const next = addBillingInterval(base, input.interval)
    return next > now ? new Date(next).toISOString() : null
  } catch (e) {
    console.error('[BILLING] estimatePeriodEnd failed (no estimate used):', e)
    return null
  }
}
