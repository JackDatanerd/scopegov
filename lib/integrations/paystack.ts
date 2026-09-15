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

export async function cancelPaystackSubscription(billing: {
  paystack_subscription_code?: string | null
  paystack_email_token?: string | null
} | null | undefined): Promise<void> {
  if (!billing?.paystack_subscription_code) return // nothing to cancel

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
      } else {
        console.error('Paystack disable error:', err)
      }
    }
  } catch (e) {
    // Best-effort: never block the caller's own operation (workspace
    // deletion, plan cancellation) on Paystack being reachable. Logged so
    // it isn't silently lost — an un-cancelled subscription behind a
    // deleted workspace needs a human to notice and follow up.
    console.error('Paystack disable call failed:', e)
  }
}
