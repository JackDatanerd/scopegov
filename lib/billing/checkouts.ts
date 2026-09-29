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
  // Stamped by charge.success once a payment has been resolved to this row
  // (migration 113). Lets subscription.create tell an abandoned popup from
  // the checkout that was actually paid when several workspaces overlap.
  charged_at?: string | null
  authorization_code?: string | null
}

const CHECKOUT_COLS = 'id, workspace_id, user_id, email, plan_key, plan_interval, plan_code, created_at, charged_at, authorization_code'

export async function createPendingCheckout(service: any, c: {
  workspaceId: string; userId: string; email: string; planKey: string; interval: string; planCode: string
}): Promise<void> {
  // FIX (Billing fix round — HIGH): every /upgrade call used to add a row and
  // leave every earlier unconsumed row for the SAME workspace + email + plan
  // sitting there. Opening the popup, closing it and trying again (or "Retry
  // with a new card" twice) is completely ordinary, and it left two live
  // candidates that findPendingCheckout could not tell apart — so a real,
  // paid subscription was reported as "ambiguous" and never applied. A
  // fresh checkout for the same workspace/email/plan replaces the earlier
  // ones: they can only ever attribute to this same workspace anyway.
  // Best-effort — findPendingCheckout also tolerates same-workspace
  // duplicates, so a failure here must not block starting a checkout.
  const stale = await service.from('billing_checkouts').delete()
    .eq('workspace_id', c.workspaceId).eq('email', c.email.trim().toLowerCase())
    .eq('plan_code', c.planCode).is('consumed_at', null)
  if (stale?.error) console.error('[BILLING] could not clear superseded checkouts:', stale.error.message)

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
  // Ambiguous AND no candidate has been charged yet. subscription.create can
  // land before charge.success, which is what stamps the paid checkout — so
  // this is "not decidable YET", not "undecidable": the caller should let
  // Paystack redeliver instead of paging a human for an unapplied payment.
  awaitingCharge?: boolean
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
  authorizationCode?: string | null,
): Promise<CheckoutResolution> {
  const none: CheckoutResolution = { checkout: null, ambiguous: false }
  if (!email || !planCode) return none
  const since = new Date(now - CHECKOUT_TTL_MS).toISOString()
  const { data, error } = await service.from('billing_checkouts')
    .select(CHECKOUT_COLS)
    .eq('email', email.trim().toLowerCase()).eq('plan_code', planCode)
    .is('consumed_at', null).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(10)
  if (error) throw new Error(`checkout lookup failed: ${error.message}`)
  const rows: PendingCheckout[] = data || []
  if (!rows.length) return none
  const hinted = hintWorkspaceId ? rows.find(r => r.workspace_id === hintWorkspaceId) : undefined
  if (hinted) return { checkout: hinted, ambiguous: false }
  if (rows.length === 1) return { checkout: rows[0], ambiguous: false }
  // FIX (Billing fix round — HIGH): several rows that ALL belong to the same
  // workspace are not ambiguous — there is only one workspace they can be
  // for (the same person re-opening checkout). Only candidates spanning
  // DIFFERENT workspaces are a genuine "can't tell". `rows` is newest-first.
  if (rows.every(r => r.workspace_id === rows[0].workspace_id)) return { checkout: rows[0], ambiguous: false }

  // FIX (Billing independent pass — B4): candidates span DIFFERENT workspaces
  // and the browser hint didn't pick one. Decide from what this server saw
  // happen, not from what the browser said:
  //  1. the card authorization on the event equals the one stamped on exactly
  //     one workspace's checkout by charge.success (exact);
  //  2. exactly one workspace has a checkout that a charge was resolved to —
  //     the others are popups that were opened and abandoned.
  // Anything else (two workspaces both paid) is a real ambiguity for a human.
  if (authorizationCode) {
    const byAuth = rows.filter(r => r.authorization_code && r.authorization_code === authorizationCode)
    if (byAuth.length && byAuth.every(r => r.workspace_id === byAuth[0].workspace_id)) {
      return { checkout: byAuth[0], ambiguous: false }
    }
  }
  const charged = rows.filter(r => !!r.charged_at)
  if (charged.length && charged.every(r => r.workspace_id === charged[0].workspace_id)) {
    return { checkout: charged[0], ambiguous: false }
  }
  return { checkout: null, ambiguous: true, awaitingCharge: charged.length === 0 }
}

/**
 * FIX (Billing re-pass, independent redo #3 — B1): the checkout row for THIS
 * exact workspace, and only that — unlike findPendingCheckout, a hint that
 * matches no row returns null instead of falling through to "the only
 * candidate" / "ambiguous". charge.success uses it to recognise the first
 * charge of a checkout this server recorded BEFORE consulting customer code
 * (which is per email, so shared by every workspace one login owns).
 * The hint (browser metadata) can only select a row this server already
 * created for the same email + plan; it can never add a candidate.
 */
export async function findHintedCheckout(
  service: any, email: string, planCode: string, hintWorkspaceId: string | null | undefined, now: number = Date.now(),
): Promise<PendingCheckout | null> {
  if (!email || !planCode || !hintWorkspaceId || typeof hintWorkspaceId !== 'string') return null
  const since = new Date(now - CHECKOUT_TTL_MS).toISOString()
  const { data, error } = await service.from('billing_checkouts')
    .select(CHECKOUT_COLS)
    .eq('email', email.trim().toLowerCase()).eq('plan_code', planCode)
    .eq('workspace_id', hintWorkspaceId)
    .is('consumed_at', null).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(1)
  if (error) throw new Error(`checkout lookup failed: ${error.message}`)
  return (data && data[0]) || null
}

/**
 * charge.success resolved a payment to this checkout: record that it was the
 * one actually paid (see findPendingCheckout). Throws on a failed write — the
 * caller is a webhook handler, where a thrown error releases the claim so
 * Paystack's redelivery retries it; leaving it unstamped would silently keep
 * the ambiguity that stamping exists to remove.
 */
export async function stampCheckoutCharged(service: any, checkout: PendingCheckout, authorizationCode?: string | null): Promise<void> {
  const patch: Record<string, unknown> = { charged_at: new Date().toISOString() }
  if (authorizationCode) patch.authorization_code = authorizationCode
  const { error } = await service.from('billing_checkouts').update(patch)
    .eq('workspace_id', checkout.workspace_id).eq('email', checkout.email)
    .eq('plan_code', checkout.plan_code).is('consumed_at', null)
  if (error) throw new Error(`could not stamp checkout as charged: ${error.message}`)
}

export async function consumeCheckout(service: any, id: string): Promise<void> {
  const { error } = await service.from('billing_checkouts')
    .update({ consumed_at: new Date().toISOString() }).eq('id', id).is('consumed_at', null)
  if (error) console.error('[BILLING] could not mark checkout consumed:', id, error.message)
}

/**
 * Consumes the resolved checkout AND any other unconsumed rows for the same
 * workspace + email + plan (leftovers from re-opened popups — see
 * createPendingCheckout). Left behind, they would keep matching later events
 * for that email/plan.
 */
export async function consumeCheckoutGroup(service: any, checkout: PendingCheckout): Promise<void> {
  await consumeCheckout(service, checkout.id)
  const { error } = await service.from('billing_checkouts')
    .update({ consumed_at: new Date().toISOString() })
    .eq('workspace_id', checkout.workspace_id).eq('email', checkout.email)
    .eq('plan_code', checkout.plan_code).is('consumed_at', null)
  if (error) console.error('[BILLING] could not consume sibling checkouts:', checkout.id, error.message)
}
