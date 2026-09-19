import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { cancelPaystackSubscription } from '@/lib/integrations/paystack'
import { getBillingRecipients } from '@/lib/billing/recipients'
import { alertBillingOps } from '@/lib/billing/ops-alert'
import { sendSubscriptionCancelScheduledEmail } from '@/lib/email/templates'

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

    // Mark locally — spec says store cancels_at_period_end: true.
    //
    // FIX (Billing re-pass #3): this write's `error` was never read. If it
    // failed after Paystack had already disabled the subscription, the
    // customer was told it worked while our record still said the
    // subscription renews. The webhook (subscription.not_renew) usually
    // self-heals that, but only if it is delivered and resolves cleanly, so
    // retry once and page a human if it still fails rather than assume.
    const localUpdate = () => (service as any).from('billing').update({
      cancels_at_period_end: true,
      updated_at: new Date().toISOString(),
    }).eq('workspace_id', session.workspaceId)
    let upd = await localUpdate()
    if (upd.error) upd = await localUpdate()
    if (upd.error) {
      await alertBillingOps(service, `billing:cancel-local-write:${session.workspaceId}`, 'Cancellation not recorded locally', [
        `workspace: ${session.workspaceId}`,
        `Paystack subscription was DISABLED but billing.cancels_at_period_end could not be set: ${upd.error.message}`,
        'The subscription_not_renew webhook should repair this; verify.',
      ])
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'billing.plan_changed', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.agencyName,
      metadata: { action: 'cancellation_requested', ends_at: billing.current_period_end, was_already_non_renewing_upstream: result.alreadyCancelled },
    })

    // FEATURE (Billing re-pass #3): tell every billing admin (not just the
    // person who clicked) that the subscription is set to end, and when.
    try {
      const endsAtLabel = billing.current_period_end
        ? new Date(billing.current_period_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        : 'the end of your current billing period'
      const recipients = await getBillingRecipients(service, session.workspaceId, [{ name: session.name, email: session.email }])
      for (const r of recipients) {
        try {
          await sendSubscriptionCancelScheduledEmail({
            to: r.email, name: r.name, agencyName: session.agencyName, endsAtLabel, actorName: session.name,
            manageUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
          })
        } catch (e) { console.error('Cancellation email failed for', r.email, e) }
      }
    } catch (e) { console.error('Cancellation notification failed:', e) }

    return NextResponse.json({ ok: true, endsAt: billing.current_period_end })
  } catch (err) {
    console.error('Billing cancel error:', err)
    return NextResponse.json({ error: 'Could not cancel the subscription' }, { status: 500 })
  }
}
