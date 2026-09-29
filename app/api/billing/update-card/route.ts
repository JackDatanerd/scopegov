// app/api/billing/update-card/route.ts
//
// FEATURE (Billing independent pass — G1): change the card on a live
// subscription without starting a new one. See generatePaystackManageLink in
// lib/integrations/paystack.ts for the gap this closes.
//
// DELIBERATELY NO step-up guard, same reasoning as billing/upgrade and
// billing/resume: this only hands out a link to a Paystack-hosted page where
// whoever holds it enters a card of their own. Nothing is removed from the
// workspace and a hijacked session gains nothing — at worst it pays the
// victim's bill.
//
// The card on file shown in Settings (billing.payment_method_last4) refreshes
// on the next charge.success, which carries the new authorization.
export const maxDuration = 30

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { generatePaystackManageLink } from '@/lib/integrations/paystack'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const service = createServiceClient()
    const { data: billing, error } = await (service as any)
      .from('billing')
      .select('paystack_subscription_code, cancels_at_period_end')
      .eq('workspace_id', session.workspaceId)
      .maybeSingle()
    if (error) {
      console.error('[BILLING] update-card: could not read billing state', error.message)
      return NextResponse.json({ error: 'Could not load your subscription. Please try again.' }, { status: 500 })
    }
    if (!billing?.paystack_subscription_code) {
      return NextResponse.json({
        error: 'There is no active subscription to update a card on. Choose a plan below to subscribe.',
      }, { status: 422 })
    }
    if (billing.cancels_at_period_end) {
      return NextResponse.json({
        error: 'This subscription is set to end. Resume it first if you want to keep it and change the card.',
      }, { status: 409 })
    }

    const result = await generatePaystackManageLink(billing.paystack_subscription_code)
    if (!result.ok || !result.link) {
      console.error('[BILLING] update-card: no manage link', result.error)
      return NextResponse.json({
        error: 'We could not open the card update page right now. Nothing has been changed — please try again in a moment.',
      }, { status: 502 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'billing.card_update_started', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.agencyName,
      metadata: { action: 'card_update_started' },
    })

    return NextResponse.json({ url: result.link })
  } catch (err) {
    console.error('Billing update-card error:', err)
    return NextResponse.json({ error: 'Could not open the card update page' }, { status: 500 })
  }
}
