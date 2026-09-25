// lib/billing/webhook-claims.ts
//
// Idempotency for the Paystack webhook, done as a CLAIM rather than a flag.
//
// FIX (Billing re-pass #3 — CRITICAL): the webhook inserted its idempotency
// key BEFORE doing any work and never took it back. If anything then failed
// (a database error, a thrown exception, a function timeout) the handler
// returned 500, Paystack redelivered the identical body, the insert hit the
// unique constraint and the handler answered 200 "duplicate" — so the event
// was permanently lost after a single transient failure. A customer could
// pay and never be upgraded, with nothing anywhere recording that it had
// happened.
//
// Now: claim ('processing') -> do the work -> mark 'done'. A failure releases
// the claim so the retry re-runs the handler (every handler write is
// idempotent). A crash that never got to release leaves a 'processing' row,
// which a later delivery takes over once it is stale. A delivery that arrives
// while another is genuinely in flight is told to come back (409).
//
// FIX (deep audit, Billing re-pass — independent redo): claimWebhookEvent's
// stale takeover already uses a compare-and-swap on claimed_at so two
// concurrent retries can't both win the SAME takeover race. But
// completeWebhookEvent/releaseWebhookEvent had no equivalent check — they
// matched on idempotency_key + status alone. So if an original attempt runs
// long enough to cross STALE_CLAIM_MS without crashing (slow, not dead) and
// a retry takes the claim over in the meantime (bumping claimed_at), the
// ORIGINAL attempt's own eventual completion or failure path would still
// unconditionally complete/delete the row — stamping it 'done' out from
// under the new owner, or deleting its claim outright so a THIRD delivery
// re-runs the handler concurrently with the second. Every caller now must
// present the exact claimed_at it was handed by claimWebhookEvent; an
// attempt whose claim was taken over in the meantime no longer matches
// anything and safely no-ops instead of clobbering the new owner's claim.

export type ClaimStatus = 'claimed' | 'duplicate' | 'in_progress'

export interface ClaimOutcome {
  status: ClaimStatus
  // Set only when status === 'claimed'. Callers must hold onto this and pass
  // it back to completeWebhookEvent/releaseWebhookEvent — see file header.
  claimedAt: string | null
}

export const STALE_CLAIM_MS = 2 * 60_000

export async function claimWebhookEvent(service: any, key: string, now: number = Date.now()): Promise<ClaimOutcome> {
  const claimedAt = new Date(now).toISOString()
  const { error } = await service.from('processed_webhook_events')
    .insert({ idempotency_key: key, status: 'processing', claimed_at: claimedAt })
  if (!error) return { status: 'claimed', claimedAt }
  if (error.code !== '23505') throw new Error(`webhook claim failed: ${error.message}`)

  const { data: existing, error: readErr } = await service.from('processed_webhook_events')
    .select('status, claimed_at').eq('idempotency_key', key).maybeSingle()
  if (readErr) throw new Error(`webhook claim lookup failed: ${readErr.message}`)
  if (!existing) return claimWebhookEvent(service, key, now) // released between our insert and read
  if (existing.status === 'done') return { status: 'duplicate', claimedAt: null }

  const age = now - new Date(existing.claimed_at).getTime()
  if (age < STALE_CLAIM_MS) return { status: 'in_progress', claimedAt: null }

  // Stale: a previous attempt died without releasing. Take over with a
  // compare-and-swap on claimed_at so two concurrent retries can't both win.
  const { data: taken, error: takeErr } = await service.from('processed_webhook_events')
    .update({ claimed_at: claimedAt })
    .eq('idempotency_key', key).eq('status', 'processing').eq('claimed_at', existing.claimed_at)
    .select('idempotency_key')
  if (takeErr) throw new Error(`webhook claim takeover failed: ${takeErr.message}`)
  return taken && taken.length > 0 ? { status: 'claimed', claimedAt } : { status: 'in_progress', claimedAt: null }
}

export async function completeWebhookEvent(service: any, key: string, claimedAt: string): Promise<void> {
  const { error } = await service.from('processed_webhook_events')
    .update({ status: 'done', processed_at: new Date().toISOString() })
    // Ownership check (see file header): only the attempt that currently
    // holds this exact claimed_at may mark it done. If someone else took
    // the claim over in the meantime, this matches zero rows and no-ops —
    // the new owner's own completeWebhookEvent will record it instead.
    .eq('idempotency_key', key).eq('status', 'processing').eq('claimed_at', claimedAt)
  // The work is already done; failing to record it only risks a harmless
  // re-run on redelivery (handlers are idempotent) — log, don't throw.
  if (error) console.error('[BILLING] could not mark webhook event done:', key, error.message)
}

export async function releaseWebhookEvent(service: any, key: string, claimedAt: string): Promise<void> {
  const { error } = await service.from('processed_webhook_events').delete()
    // Ownership check (see file header): never delete a claim someone else
    // has since taken over — only our own, still-current claimed_at.
    .eq('idempotency_key', key).eq('status', 'processing').eq('claimed_at', claimedAt)
  if (error) console.error('[BILLING] could not release webhook claim (a later delivery will take over once stale):', key, error.message)
}
