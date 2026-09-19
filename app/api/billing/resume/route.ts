// app/api/billing/resume/route.ts
//
// FEATURE (build, Billing re-pass): cancels_at_period_end exists so a
// customer who cancels keeps access — and the option to change their
// mind — until the period they already paid for runs out. Nothing ever
// let them actually change their mind: billing/cancel and the webhook
// could both set cancels_at_period_end, but no route could ever clear it
// back. The only way back in was to let the period lapse (cron/
// payment-overdue then force-downgrades to Solo) and start a brand-new
// checkout from scratch. Mirrors billing/cancel exactly, just the other
// verb — same permission gate, same billing-row shape, same "don't tell
// the customer it worked unless Paystack actually agrees" discipline.
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { resumePaystackSubscription } from '@/lib/integrations/paystack'
import { getBillingRecipients } from '@/lib/billing/recipients'
import { alertBillingOps } from '@/lib/billing/ops-alert'
import { sendSubscriptionResumedEmail } from '@/lib/email/templates'

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
      .maybeSingle()

    if (!billing?.paystack_subscription_code) {
      return NextResponse.json({
        error: 'No active subscription found. Contact support@scopegov.app to resume.',
        contactSupport: true,
      }, { status: 422 })
    }

    if (!billing.cancels_at_period_end) {
      return NextResponse.json({ error: 'This subscription is not scheduled for cancellation.' }, { status: 409 })
    }

    // Once the period has actually lapsed, cron/payment-overdue's step 5
    // has already (or is about to) clear the subscription code and force
    // the workspace to Solo — at that point there's nothing left to
    // resume, and re-subscribing needs a fresh checkout instead. Same
    // boundary billing/cancel's caller and the cron sweep already agree on.
    if (billing.current_period_end && new Date(billing.current_period_end) < new Date()) {
      return NextResponse.json({
        error: 'Your billing period has already ended — start a new subscription from the plans below instead.',
      }, { status: 409 })
    }

    const result = await resumePaystackSubscription(billing)
    if (!result.ok) {
      return NextResponse.json({
        error: 'We could not reach Paystack to resume your subscription. Nothing has been charged or changed — please try again in a moment, or contact support@scopegov.app if this keeps happening.',
      }, { status: 502 })
    }

    // FIX (Billing re-pass #3): the write's `error` was never read — see
    // billing/cancel for the same reasoning. Paystack has already re-enabled
    // renewal at this point.
    const localUpdate = () => (service as any).from('billing').update({
      cancels_at_period_end: false,
      updated_at: new Date().toISOString(),
    }).eq('workspace_id', session.workspaceId)
    let upd = await localUpdate()
    if (upd.error) upd = await localUpdate()
    if (upd.error) {
      await alertBillingOps(service, `billing:resume-local-write:${session.workspaceId}`, 'Resume not recorded locally', [
        `workspace: ${session.workspaceId}`,
        `Paystack subscription was RE-ENABLED but billing.cancels_at_period_end could not be cleared: ${upd.error.message}`,
        'Left as-is, the period-end sweep would downgrade a customer who is still being charged.',
      ])
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'billing.plan_changed', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.agencyName,
      metadata: { action: 'cancellation_reversed' },
    })

    try {
      const recipients = await getBillingRecipients(service, session.workspaceId, [{ name: session.name, email: session.email }])
      for (const r of recipients) {
        try {
          await sendSubscriptionResumedEmail({
            to: r.email, name: r.name, agencyName: session.agencyName, actorName: session.name,
            manageUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
          })
        } catch (e) { console.error('Resume email failed for', r.email, e) }
      }
    } catch (e) { console.error('Resume notification failed:', e) }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Billing resume error:', err)
    return NextResponse.json({ error: 'Could not resume the subscription' }, { status: 500 })
  }
}
