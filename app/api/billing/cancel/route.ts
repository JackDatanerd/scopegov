import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

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
        const err = await resp.json()
        // Carry-forward §5.6: non-renewing status after recent cancel
        if (err.message?.includes('already') || err.message?.includes('non-renewing')) {
          // Already cancelled — still mark locally
        } else {
          console.error('Paystack disable error:', err)
        }
      }
    } catch (e) {
      console.error('Paystack disable call failed:', e)
    }

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
