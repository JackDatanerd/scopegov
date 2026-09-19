// app/api/billing/status/route.ts
//
// Lightweight read of the current plan/subscription state for the Billing
// tab. Paystack's popup reports "paid" to the browser before the webhook has
// (asynchronously) upgraded the workspace (BUG-054: the plan changes ONLY on
// the webhook), so right after checkout the page used to reload straight
// into the OLD plan with an alert promising it would update "within a
// minute". The tab now polls this until the plan actually changes.
export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const service = createServiceClient()
    const [ws, billing] = await Promise.all([
      (service as any).from('workspaces').select('plan_tier').eq('id', session.workspaceId).maybeSingle(),
      (service as any).from('billing')
        .select('paystack_subscription_code, plan_interval, current_period_end, cancels_at_period_end, grace_period_started_at')
        .eq('workspace_id', session.workspaceId).maybeSingle(),
    ])
    if (ws.error) throw new Error(ws.error.message)
    if (billing.error) throw new Error(billing.error.message)

    return NextResponse.json({
      planTier: ws.data?.plan_tier ?? null,
      planInterval: billing.data?.plan_interval ?? null,
      currentPeriodEnd: billing.data?.current_period_end ?? null,
      cancelsAtPeriodEnd: !!billing.data?.cancels_at_period_end,
      graceStartedAt: billing.data?.grace_period_started_at ?? null,
      hasSubscription: !!billing.data?.paystack_subscription_code,
    })
  } catch (err) {
    console.error('Billing status error:', err)
    return NextResponse.json({ error: 'Could not load billing status' }, { status: 500 })
  }
}
