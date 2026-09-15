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

export interface CancelPaystackResult {
  ok: boolean
  alreadyCancelled: boolean
  error?: string
}

export async function cancelPaystackSubscription(billing: {
  paystack_subscription_code?: string | null
  paystack_email_token?: string | null
} | null | undefined): Promise<CancelPaystackResult> {
  if (!billing?.paystack_subscription_code) return { ok: true, alreadyCancelled: true } // nothing to cancel

  try {
    const resp = await fetch('https://api.paystack.co/subscription/disable', {
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
      if (err.message?.includes('already') || err.message?.includes('non-renewing')) {
        // Already cancelled — nothing further to do.
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
