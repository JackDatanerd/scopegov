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
import { cancelPaystackSubscription, fetchPaystackNextPaymentDate, fetchPaystackSubscription } from '@/lib/integrations/paystack'
import { UPSTREAM_ENDED_STATUSES } from '@/lib/billing/plans'
import { estimatePeriodEnd } from '@/lib/billing/period-end'
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
      .select('paystack_subscription_code, paystack_email_token, cancels_at_period_end, current_period_end, plan_interval, grace_period_started_at')
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
    //
    // FIX (Billing independent pass 8): a date that is PRESENT but already in the past is just as unsafe. Right
    // after a renewal the stored current_period_end can still be the one that just elapsed (the webhook
    // refreshes it a moment later). Flagging cancels_at_period_end against a past date lets payment-overdue
    // step 5 (which selects cancelling rows whose period end has passed) downgrade a customer who has just
    // paid for another period, and the email would show a past date. So a missing OR elapsed date is refreshed
    // from Paystack first — before the claim, because a disabled subscription reports no next payment date.
    let backfilledPeriodEnd: string | null = null
    const storedEndMs = billing.current_period_end ? Date.parse(billing.current_period_end) : NaN
    if (!billing.current_period_end || isNaN(storedEndMs) || storedEndMs <= Date.now()) {
      try {
        const fetched = await fetchPaystackNextPaymentDate(code)
        if (fetched && !isNaN(Date.parse(fetched)) && Date.parse(fetched) > Date.now()) backfilledPeriodEnd = fetched
      } catch (e) { console.error('[BILLING] cancel: could not backfill current_period_end', e) }
    }
    // FIX (Billing independent pass 10 — B1): Paystack can still show the date that JUST elapsed right after a
    // renewal, and a failed read leaves nothing at all. Falling through to "flag it anyway" is what let step 5
    // downgrade a customer who had just paid (elapsed date) or never end the plan (missing date). Use what this
    // app recorded instead — see lib/billing/period-end.ts for when it refuses to guess. If it still has
    // nothing the cancel goes through unchanged (a customer must always be able to cancel) and ops is told below.
    let periodEndEstimated = false
    const needsDate = !billing.current_period_end || isNaN(storedEndMs) || storedEndMs <= Date.now()
    if (!backfilledPeriodEnd && needsDate) {
      const est = await estimatePeriodEnd(service, {
        workspaceId: session.workspaceId, storedEnd: billing.current_period_end,
        interval: billing.plan_interval, graceStartedAt: billing.grace_period_started_at,
      })
      if (est) { backfilledPeriodEnd = est; periodEndEstimated = true }
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
    let result = await cancelPaystackSubscription(billing)
    // FIX (Billing independent pass 10 — B2): a timeout or a lost response after Paystack ACCEPTED the disable
    // looks exactly like a refusal. Rolling the claim back then leaves our row saying "renewing" for a
    // subscription Paystack has already stopped (the not_renew webhook that could have told us arrived while
    // the claim was held, so it deliberately did nothing) until the daily reconciliation notices. Ask Paystack
    // what state it is really in before giving the claim back.
    if (!result.ok) {
      const check = await fetchPaystackSubscription(code)
      if (check.ok && check.sub.status && UPSTREAM_ENDED_STATUSES.has(check.sub.status)) {
        result = { ok: true, alreadyCancelled: true }
      }
    }
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
      metadata: {
        action: 'cancellation_requested', ends_at: billing.current_period_end, was_already_non_renewing_upstream: result.alreadyCancelled,
        ...(periodEndEstimated ? { period_end_estimated: true } : {}),
      },
    })

    // A cancellation with no period end at all is never picked up by the period-end sweep — the plan would
    // outlive the subscription. The reconciliation cron also tries to repair it; this makes sure a human sees it
    // if that cannot either. (A grace-period workspace is handled by grace enforcement instead.)
    if (!billing.current_period_end && !billing.grace_period_started_at) {
      await alertBillingOps(service, `billing:cancel-no-period-end:${session.workspaceId}`, 'Cancellation recorded without a period end', [
        `workspace: ${session.workspaceId}`,
        `subscription: ${code}`,
        'The subscription was disabled on Paystack but no period end could be determined, so the period-end sweep cannot end the paid plan. Set billing.current_period_end by hand.',
      ]).catch(() => {})
    }

    // FEATURE (Billing re-pass #3): tell every billing admin (not just the
    // person who clicked) that the subscription is set to end, and when.
    try {
      const endsAtLabel = billing.current_period_end
        ? new Date(billing.current_period_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        : 'the end of your current billing period'
      const recipients = await getBillingRecipients(service, session.workspaceId, [{ name: session.name, email: session.email }])
      // FIX (Billing independent pass 10 — B4): sendEmail-backed helpers resolve { ok: false } instead of
      // throwing, and that result was discarded — a rejected notification left no trace anywhere.
      let anySent = false
      for (const r of recipients) {
        try {
          const delivery = await sendSubscriptionCancelScheduledEmail({
            to: r.email, name: r.name, agencyName: session.agencyName, endsAtLabel, actorName: session.name,
            manageUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
          })
          if (delivery && !delivery.ok) console.error('Cancellation email rejected for', r.email, delivery.error)
          else anySent = true
        } catch (e) { console.error('Cancellation email failed for', r.email, e) }
      }
      if (recipients.length > 0 && !anySent) {
        await alertBillingOps(service, `billing:cancel-email:${session.workspaceId}`, 'Cancellation email was not delivered', [
          `Workspace ${session.workspaceId} scheduled a cancellation but no billing recipient could be emailed.`,
        ]).catch(() => {})
      }
    } catch (e) { console.error('Cancellation notification failed:', e) }

    return NextResponse.json({ ok: true, endsAt: billing.current_period_end })
  } catch (err) {
    console.error('Billing cancel error:', err)
    return NextResponse.json({ error: 'Could not cancel the subscription' }, { status: 500 })
  }
}
