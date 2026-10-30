// app/api/billing/confirm/route.ts
//
// Called by the Billing tab while it shows "Payment received — confirming your plan". If the Paystack webhook has not
// activated the plan, this asks Paystack directly about the payment the popup reported and applies it through the
// same handler the webhook uses (lib/billing/recover-checkout.ts). Cheap and harmless when the webhook already won.
export const runtime = 'nodejs'
export const maxDuration = 60

import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { recoverPaidCheckout } from '@/lib/billing/recover-checkout'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const result = await recoverPaidCheckout(createServiceClient(), session.workspaceId, body?.reference)
    return NextResponse.json(result)
  } catch (err) {
    console.error('Billing confirm error:', err)
    return NextResponse.json({ state: 'unavailable', detail: 'Could not confirm the payment' }, { status: 500 })
  }
}
