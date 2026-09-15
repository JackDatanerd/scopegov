import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { cancelPaystackSubscription } from '@/lib/integrations/paystack'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const service = createServiceClient()
    const { data: billing } = await (service as any)
      .from('billing')
      .select('paystack_subscription_code, paystack_email_token, cancels_at_period_end, current_period_end')
      .eq('workspace_id', session.workspaceId)
      .single()

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
    await cancelPaystackSubscription(billing)

    // Mark locally — spec says store cancels_at_period_end: true
    await (service as any).from('billing').update({
      cancels_at_period_end: true,
      updated_at: new Date().toISOString(),
    }).eq('workspace_id', session.workspaceId)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'billing.plan_changed', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.agencyName,
      metadata: { action: 'cancellation_requested', ends_at: billing.current_period_end },
    })

    return NextResponse.json({ ok: true, endsAt: billing.current_period_end })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
