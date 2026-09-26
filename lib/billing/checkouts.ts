// lib/billing/checkouts.ts
//
// Server-side record of "workspace W started a checkout for plan P as
// customer E" — see migration 056 (billing_checkouts) for why the browser's
// popup metadata can't be trusted to say which workspace a payment is for.

export const CHECKOUT_TTL_MS = 24 * 60 * 60_000

export interface PendingCheckout {
  id: string
  workspace_id: string
  user_id: string | null
  email: string
  plan_key: string
  plan_interval: string
  plan_code: string
  created_at: string
}

export async function createPendingCheckout(service: any, c: {
  workspaceId: string; userId: string; email: string; planKey: string; interval: string; planCode: string
}): Promise<void> {
  const { error } = await service.from('billing_checkouts').insert({
    workspace_id: c.workspaceId, user_id: c.userId, email: c.email.trim().toLowerCase(),
    plan_key: c.planKey, plan_interval: c.interval, plan_code: c.planCode,
  })
  if (error) throw new Error(`could not record checkout: ${error.message}`)
}

export interface CheckoutResolution {
  checkout: PendingCheckout | null
  // True when more than one unconsumed candidate existed for this
  // (email, plan_code) and hintWorkspaceId didn't identify one of them —
  // there is genuinely no way to tell which workspace this event is for.
  ambiguous: boolean
}

/**
 * The workspace a (customer email, plan code) payment belongs to, decided
 * ONLY from rows this server created. `hintWorkspaceId` (the browser's
 * metadata) can break a tie between candidates; it can never add one.
 *
 * FIX (deep audit, Billing re-pass — independent redo): with zero or one
 * candidate this always worked. With MORE than one — a real, supported
 * scenario, since one login can own several workspaces and each can start
 * its own checkout for the exact same plan+interval inside the 24h
 * CHECKOUT_TTL_MS window — a hint that didn't match ANY candidate used to
 * fall through to `rows[0]` (whichever checkout was created most recently)
 * regardless. That is not "breaking a tie", it's fabricating an answer from
 * nothing: whichever workspace's popup happens to complete payment FIRST
 * gets attributed to whichever checkout was merely started LAST. The
 * customer who actually paid stays on their old plan (their own checkout
 * row just sits there unconsumed) while an unrelated sibling workspace gets
 * the entitlement and the real Paystack subscription code bound to it. The
 * hint is populated from data?.metadata?.workspaceId on the Paystack event
 * — reliably present on a Transaction resource (charge.success) but there
 * is no confirmed evidence it survives onto a Subscription resource
 * (subscription.create, the 'strict'-mode caller this matters most for);
 * if it doesn't, the multi-candidate case wasn't a rare edge, it was the
 * NORMAL path whenever it occurred. Ambiguity is now reported instead of
 * guessed; resolveWorkspace surfaces it exactly like the existing
 * customer-code-matches-more-than-one-workspace case already does, which
 * alerts a human rather than silently misattributing a paid subscription.
 */
export async function findPendingCheckout(
  service: any, email: string, planCode: string, hintWorkspaceId?: string | null, now: number = Date.now(),
): Promise<CheckoutResolution> {
  const none: CheckoutResolution = { checkout: null, ambiguous: false }
  if (!email || !planCode) return none
  const since = new Date(now - CHECKOUT_TTL_MS).toISOString()
  const { data, error } = await service.from('billing_checkouts')
    .select('id, workspace_id, user_id, email, plan_key, plan_interval, plan_code, created_at')
    .eq('email', email.trim().toLowerCase()).eq('plan_code', planCode)
    .is('consumed_at', null).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(10)
  if (error) throw new Error(`checkout lookup failed: ${error.message}`)
  const rows: PendingCheckout[] = data || []
  if (!rows.length) return none
  const hinted = hintWorkspaceId ? rows.find(r => r.workspace_id === hintWorkspaceId) : undefined
  if (hinted) return { checkout: hinted, ambiguous: false }
  if (rows.length === 1) return { checkout: rows[0], ambiguous: false }
  return { checkout: null, ambiguous: true }
}

export async function consumeCheckout(service: any, id: string): Promise<void> {
  const { error } = await service.from('billing_checkouts')
    .update({ consumed_at: new Date().toISOString() }).eq('id', id).is('consumed_at', null)
  if (error) console.error('[BILLING] could not mark checkout consumed:', id, error.message)
}
