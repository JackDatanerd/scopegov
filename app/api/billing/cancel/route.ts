// FIX (deep audit, Billing re-pass — independent redo): no explicit
// maxDuration was set, so this route ran under Vercel's platform default (as
// low as 10s), the same class of bug already fixed in
// app/api/sow/generate/route.ts and app/api/billing/webhook/route.ts.
// cancelPaystackSubscription below carries its own 12s internal timeout
// (lib/integrations/paystack.ts) on the user-facing "cancel my subscription"
// request — a legitimately slow-but-successful Paystack response could
// exceed the platform default on its own.
//
// FIX (Billing independent pass — B8): raised 30 -> 60. The worst case of the
// Paystack work alone is two sequential 12s calls (fetch the email token when
// none is on file, then disable), before the database round-trips, the
// rollback path and one email per billing admin — 30s left no headroom, and a
// mid-write kill is exactly the failure this route now has to be able to undo.
export const maxDuration = 60

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logBillingAuditWithRetry } from '@/lib/billing/audit-retry'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { getClientIp } from '@/lib/utils/request-ip'
import { cancelPaystackSubscription, fetchPaystackNextPaymentDate } from '@/lib/integrations/paystack'
import { getBillingRecipients } from '@/lib/billing/recipients'
import { alertBillingOps } from '@/lib/billing/ops-alert'
import { sendSubscriptionCancelScheduledEmail } from '@/lib/email/templates'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp

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
    const { data: billing, error: billingErr } = await (service as any)
      .from('billing')
      .select('paystack_subscription_code, paystack_email_token, cancels_at_period_end, current_period_end')
      .eq('workspace_id', session.workspaceId)
      .maybeSingle()
    // FIX (Billing independent pass): a failed read used to fall into the
    // "No active subscription found — contact support" branch below, telling a
    // paying customer with a healthy subscription there is nothing to cancel.
    if (billingErr) {
      console.error('[BILLING] cancel: could not read billing state', billingErr.message)
      return NextResponse.json({ error: 'Could not load your subscription. Please try again.' }, { status: 500 })
    }

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

    // FIX (Billing independent pass — B1 / B7): CLAIM FIRST, THEN CALL PAYSTACK.
    //
    // The local flag used to be written AFTER the Paystack call, by
    // workspace_id alone. Two problems followed from that ordering:
    //  (B1) Paystack's disable can take up to 2 x 12s. If a plan switch
    //       (subscription.create) landed in that window it replaced the
    //       subscription code — and this write then flagged the NEW, paid
    //       subscription as cancelling. Paystack kept charging it; the
    //       period-end sweep later downgraded the customer to Solo anyway.
    //  (B7) The disable makes Paystack fire subscription.not_renew, which can
    //       reach the webhook before this route writes anything: two audit
    //       rows for one cancellation. Two quick clicks did the same.
    //
    // Claiming first fixes both. The write is a compare-and-set on the exact
    // subscription code we read AND on cancels_at_period_end = false, so:
    //  - only one request can ever hold the claim (a second click gets the
    //    "already scheduled" answer below instead of a duplicate cancel);
    //  - the webhook's own not_renew handler already returns early when it
    //    sees the flag ("the cancel route already recorded it"), and now it
    //    always does, because the flag is set before Paystack is asked;
    //  - a plan switch that replaced the code matches zero rows and cannot be
    //    flagged. If Paystack then refuses, the claim is rolled back (below).
    const code = billing.paystack_subscription_code as string

    // FIX (Billing independent pass 7 — latent): cron/payment-overdue step 5 only selects rows whose
    // current_period_end IS NOT NULL. A subscription recorded without a next_payment_date could therefore be
    // cancelled here and then never be downgraded at period end (paid plan kept free indefinitely). When the
    // date is missing, take it from Paystack now and store it with the claim. Best-effort: a failed read just
    // leaves the old behaviour (the daily billing-reconcile cron also fills it in once it is in the future).
    let backfilledPeriodEnd: string | null = null
    if (!billing.current_period_end) {
      try {
        const fetched = await fetchPaystackNextPaymentDate(code)
        if (fetched && !isNaN(Date.parse(fetched)) && Date.parse(fetched) > Date.now()) backfilledPeriodEnd = fetched
      } catch (e) { console.error('[BILLING] cancel: could not backfill current_period_end', e) }
    }
    if (backfilledPeriodEnd) billing.current_period_end = backfilledPeriodEnd

    const claim = await (service as any).from('billing')
      .update({
        cancels_at_period_end: true, updated_at: new Date().toISOString(),
        ...(backfilledPeriodEnd ? { current_period_end: backfilledPeriodEnd } : {}),
      })
      .eq('workspace_id', session.workspaceId)
      .eq('paystack_subscription_code', code)
      .eq('cancels_at_period_end', false)
      .select('workspace_id')
    if (claim.error) {
      console.error('[BILLING] cancel: could not record the cancellation claim', claim.error.message)
      return NextResponse.json({ error: 'Could not cancel the subscription. Nothing has been changed — please try again.' }, { status: 500 })
    }
    if (!claim.data || claim.data.length === 0) {
      // Lost the race. Say what is true now rather than guessing.
      const { data: now } = await (service as any).from('billing')
        .select('paystack_subscription_code, cancels_at_period_end, current_period_end')
        .eq('workspace_id', session.workspaceId).maybeSingle()
      if (now?.paystack_subscription_code === code && now.cancels_at_period_end) {
        return NextResponse.json({
          error: 'Subscription is already scheduled for cancellation.',
          endsAt: now.current_period_end,
        }, { status: 409 })
      }
      return NextResponse.json({
        error: 'Your subscription changed while we were processing this. Nothing was cancelled — check Billing and try again if you still want to cancel.',
        planChanged: true,
      }, { status: 409 })
    }

    // Call Paystack to disable subscription
    // FIX (section-by-section re-audit): extracted to
    // lib/integrations/paystack.ts so workspace/delete can share the
    // exact same cancellation logic instead of independently forgetting
    // to call it.
    //
    // FIX (audit round 6): only report success when Paystack actually agrees
    // the subscription won't renew — the helper returns a real result.
    const result = await cancelPaystackSubscription(billing)
    if (!result.ok) {
      // Give the claim back, but only if the row still holds OUR subscription
      // and OUR flag: a plan switch that landed meanwhile has already reset it
      // for the new subscription, which must not be touched. Retried once — a
      // claim left set on a subscription Paystack still renews is the one bad
      // outcome here (the customer keeps being charged, then gets downgraded).
      const rollback = () => (service as any).from('billing')
        .update({ cancels_at_period_end: false, updated_at: new Date().toISOString() })
        .eq('workspace_id', session.workspaceId)
        .eq('paystack_subscription_code', code)
        .eq('cancels_at_period_end', true)
      let rb = await rollback()
      if (rb.error) rb = await rollback()
      if (rb.error) {
        await alertBillingOps(service, `billing:cancel-rollback:${session.workspaceId}`, 'Cancellation claim could not be rolled back', [
          `workspace: ${session.workspaceId}`,
          `subscription: ${code}`,
          `Paystack refused the disable (${result.error ?? 'unknown error'}) and billing.cancels_at_period_end could not be cleared: ${rb.error.message}`,
          'The subscription is still renewing on Paystack but flagged as cancelling locally — the period-end sweep would downgrade a paying customer. Clear the flag or disable the subscription by hand.',
        ])
      }
      return NextResponse.json({
        error: 'We could not reach Paystack to cancel your subscription. Nothing has been charged or changed — please try again in a moment, or contact support@scopegov.app if this keeps happening.',
      }, { status: 502 })
    }

    // A plan switch can have landed while Paystack was being called. It disables
    // THIS (old) subscription itself, so the call above was harmless — but the
    // customer's new, paid subscription is live and is not cancelling, and "your
    // cancellation succeeded" would be untrue. Say so instead.
    const { data: after } = await (service as any).from('billing')
      .select('paystack_subscription_code')
      .eq('workspace_id', session.workspaceId).maybeSingle()
    if (after && after.paystack_subscription_code !== code) {
      return NextResponse.json({
        error: 'Your plan changed while we were processing this, so your new subscription was not cancelled. Check Billing and try again if you still want to cancel.',
        planChanged: true,
      }, { status: 409 })
    }

    // FIX (Billing independent pass 7 — B1): retried + ops-paged on failure; see lib/billing/audit-retry.ts.
    await logBillingAuditWithRetry(service, {
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
