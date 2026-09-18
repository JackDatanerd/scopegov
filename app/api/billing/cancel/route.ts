import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { cancelPaystackSubscription } from '@/lib/integrations/paystack'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const service = createServiceClient()
    // FIX (deep audit, Billing re-pass, minor): this was `.single()` — the
    // rest of the codebase (settings/page.tsx, workspace/delete/route.ts)
    // explicitly uses `.maybeSingle()` here with a comment noting the
    // billing row may not exist at all for a trial workspace that's never
    // subscribed. `.single()` happened to still behave correctly (a
    // zero-rows PostgREST error resolves to `data: null` rather than
    // throwing, so the `!billing?.paystack_subscription_code` check below
    // still catches it) but it's the one place in this codebase that
    // pattern is spelled differently for the same known condition.
    const { data: billing } = await (service as any)
      .from('billing')
      .select('paystack_subscription_code, paystack_email_token, cancels_at_period_end, current_period_end')
      .eq('workspace_id', session.workspaceId)
      .maybeSingle()

    // Carry-forward §5.6: if no subscription code yet, show support message
    if (!billing?.paystack_subscription_code) {
      return NextResponse.json({
        error: 'No active subscription found. Contact support@scopegov.app to cancel.',
        contactSupport: true,
      }, { status: 422 })
    }

    if (billing.cancels_at_period_end) {
      return NextResponse.json({
        error: 'Subscription is already scheduled for cancellation.',
        endsAt: billing.current_period_end,
      }, { status: 409 })
    }

    // Call Paystack to disable subscription
    // FIX (section-by-section re-audit): extracted to
    // lib/integrations/paystack.ts so workspace/delete can share the
    // exact same cancellation logic instead of independently forgetting
    // to call it.
    //
    // FIX (audit round 6): this used to ignore the outcome entirely
    // (the helper was `void`-returning) and fall through unconditionally
    // to marking cancels_at_period_end: true locally — telling the
    // customer their cancellation succeeded even when the real Paystack
    // call failed for a reason other than "already cancelled." That left
    // the real subscription renewing (and charging the customer again on
    // schedule) while the local flag then blocked any retry through the
    // UI ("already scheduled for cancellation"). The helper now returns a
    // real result — only proceed to the local write when Paystack
    // actually agrees the subscription won't renew.
    const result = await cancelPaystackSubscription(billing)
    if (!result.ok) {
      return NextResponse.json({
        error: 'We could not reach Paystack to cancel your subscription. Nothing has been charged or changed — please try again in a moment, or contact support@scopegov.app if this keeps happening.',
      }, { status: 502 })
    }

    // Mark locally — spec says store cancels_at_period_end: true
    await (service as any).from('billing').update({
      cancels_at_period_end: true,
      updated_at: new Date().toISOString(),
    }).eq('workspace_id', session.workspaceId)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'billing.plan_changed', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.agencyName,
      metadata: { action: 'cancellation_requested', ends_at: billing.current_period_end, was_already_non_renewing_upstream: result.alreadyCancelled },
    })

    return NextResponse.json({ ok: true, endsAt: billing.current_period_end })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
