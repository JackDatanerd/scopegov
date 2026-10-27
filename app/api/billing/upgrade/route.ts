import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { parsePlanRequest, planCodeFor } from '@/lib/billing/plans'
import { createPendingCheckout } from '@/lib/billing/checkouts'
import { measurePlanFit } from '@/lib/billing/limits'
import { getPaystackPublicKey, PAYSTACK_PUBLIC_KEY_ENV_NAMES } from '@/lib/billing/paystack-public-key'

// Billing re-pass #3:
//  - planKey / interval are parsed once against an allowlist and normalised
//    (lib/billing/plans.ts). Before, `planKey.toUpperCase()` built the env
//    name while PLAN_LIMITS was indexed with the RAW value, so "SOLO" found a
//    real plan code but skipped BOTH downgrade guards below; a non-string
//    threw a TypeError whose text was returned to the browser.
//  - The checkout is recorded server-side (billing_checkouts) so the webhook
//    can bind the resulting subscription to THIS workspace without trusting
//    the metadata the browser hands to Paystack's popup.
//  - Re-buying the plan + interval the workspace already has (two tabs, a
//    direct call) is refused instead of creating a second, immediately
//    charged subscription for nothing.
//
// DELIBERATELY NO step-up (re-authentication) guard here — do not add one back.
// An earlier audit added one on the reasoning that this route can switch to a
// cheaper tier and thereby disable the current subscription. But nothing
// changes until the person completes a payment in Paystack's popup with a card
// they enter themselves: a hijacked session gains nothing by "buying" a plan
// (the attacker would be paying the victim's bill), whereas the prompt sat at
// the exact moment of conversion — including the grace-period "Retry with a
// new card" recovery flow — and asked people who had just decided to pay us to
// pass an MFA/password challenge first. billing/cancel, which destroys value
// with no payment involved, keeps its guard.
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const parsed = parsePlanRequest(body?.planKey, body?.interval)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { planKey, interval } = parsed

    const planCode = planCodeFor(planKey, interval)
    if (!planCode) {
      // Which env var is missing is an operator concern, not the browser's.
      console.error(`[BILLING] Plan code not configured: ${parsed.envKey}`)
      return NextResponse.json({ error: 'This plan is not available for purchase right now. Please contact support@scopegov.app.' }, { status: 422 })
    }

    // FIX (Billing independent pass — B5): both keys are required for a payment to
    // work end to end, and neither was checked. A missing public key recorded a
    // checkout and handed the popup `publicKey: undefined`; a missing SECRET key was
    // worse — customers could still pay, but verifyPaystackSignature() fails closed
    // on an unset secret, so EVERY webhook was rejected with 401 and nobody was ever
    // upgraded, for money that had already been taken. Refuse before any money can
    // move, and tell the operator which one is missing.
    // FIX (Billing / trial-end audit): the public key was read ONLY as NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY. Vercel warns
    // about a NEXT_PUBLIC_ name containing "KEY", the operator renamed it, and every checkout then failed with "Payments
    // are not available right now". It is server-read-only (returned in the JSON below), so the prefix was never
    // needed: accept PAYSTACK_PUBLIC_KEY plus both older names (lib/billing/paystack-public-key.ts).
    const publicKey = getPaystackPublicKey()
    if (!publicKey || !process.env.PAYSTACK_SECRET_KEY) {
      console.error(`[BILLING] Checkout refused — payments are not configured: ${[
        !publicKey && `a Paystack public key (set ${PAYSTACK_PUBLIC_KEY_ENV_NAMES[0]})`,
        !process.env.PAYSTACK_SECRET_KEY && 'PAYSTACK_SECRET_KEY',
      ].filter(Boolean).join(', ')} is not set`)
      return NextResponse.json({ error: 'Payments are not available right now. Please contact support@scopegov.app.' }, { status: 503 })
    }

    const service = createServiceClient()

    // Already on exactly this plan + interval with a healthy, renewing
    // subscription: nothing to buy.
    const [{ data: ws, error: wsError }, { data: billing, error: billingError }] = await Promise.all([
      (service as any).from('workspaces').select('plan_tier').eq('id', session.workspaceId).maybeSingle(),
      (service as any).from('billing')
        .select('paystack_subscription_code, plan_interval, cancels_at_period_end, grace_period_started_at')
        .eq('workspace_id', session.workspaceId).maybeSingle(),
    ])
    // FIX (Billing independent audit, round 6 — B2, LOW): this used to destructure
    // only `data`, silently dropping `error`. A failed read here isn't harmless —
    // it means the "already on this exact plan" guard below can't see the real
    // state and gets skipped, letting an unnecessary duplicate checkout be
    // created. `status/route.ts` already treats the identical query shape as
    // fatal; do the same here instead of quietly proceeding on stale/empty data.
    if (wsError || billingError) {
      console.error('[BILLING] upgrade: failed to read workspace/billing state', wsError || billingError)
      return NextResponse.json({ error: 'Could not verify current plan. Please try again.' }, { status: 500 })
    }
    if (
      ws?.plan_tier === planKey && billing?.paystack_subscription_code &&
      billing.plan_interval === interval && !billing.cancels_at_period_end && !billing.grace_period_started_at
    ) {
      return NextResponse.json({ error: `This workspace is already on the ${PLAN_LIMITS[planKey]?.name} plan (${interval}).`, alreadyOnPlan: true }, { status: 409 })
    }

    // FIX (deep audit, Settings re-pass): seat limit checked server-side, authoritatively, before money changes
    // hands — and the same for the project limit (Billing re-pass). Both counts now come from
    // lib/billing/limits.ts, which reports a failed read as an error instead of counting it as 0.
    //
    // FIX (Billing independent pass 10 — B5): a failed count used to be treated as zero, so the guard passed
    // silently exactly when it could not see the real usage — the same class of bug as the workspace/billing
    // reads above (round 6). Refuse instead of guessing.
    const planFit = await measurePlanFit(service, session.workspaceId, planKey)
    if (!planFit.ok) {
      console.error('[BILLING] upgrade: failed to measure usage against the target plan', planFit.error)
      return NextResponse.json({ error: 'Could not verify current plan. Please try again.' }, { status: 500 })
    }
    const { seats, projects } = planFit.fit
    const planName = PLAN_LIMITS[planKey]?.name || planKey

    // FIX (Billing / trial-end audit — HIGH): a READ-ONLY (lapsed) workspace cannot do what the two refusals below ask.
    // The lapse strips INVITE_MEMBERS (Deactivate), MARK_PROJECT_COMPLETE (Archive) and DELETE_PROJECTS, so a lapsed
    // workspace over the target plan's allowance — every ex-trial with 2+ members or 3+ projects trying Solo or
    // Starter — was told to "deactivate members first" with the Team page frozen: it could only buy a bigger, dearer
    // plan. The webhook already accepts over-limit usage after payment (it records over_limit and alerts ops, and
    // the Team page shows an over-seat banner), and buying a plan is what restores the permissions needed to fix it.
    // So for a lapsed workspace the overage is allowed, but only after the buyer has been told and has acknowledged it
    // (`acknowledgeOverLimit`, set by the Billing tab after its confirm dialog). A workspace that is NOT lapsed can
    // still deactivate / archive, so it keeps the hard refusal.
    if (session.lapsed && (seats.over || projects.over)) {
      const parts: string[] = []
      if (seats.over) parts.push(`${seats.count} active member${seats.count === 1 ? '' : 's'} (${planName} includes ${seats.limit})`)
      if (projects.over) parts.push(`${projects.count} active project${projects.count === 1 ? '' : 's'} (${planName} includes ${projects.limit})`)
      if (body?.acknowledgeOverLimit !== true) {
        return NextResponse.json({
          error: `This workspace has ${parts.join(' and ')}. You can still subscribe to ${planName} now — your data stays intact and nobody is removed. Once the plan is active you can deactivate members or archive projects to get back within its limits; until then you can't invite or add more.`,
          overLimitAckRequired: true,
          overLimit: { seats: seats.over ? { count: seats.count, limit: seats.limit } : null, projects: projects.over ? { count: projects.count, limit: projects.limit } : null },
        }, { status: 409 })
      }
    } else {
      if (seats.over) {
        return NextResponse.json({
          error: `This workspace has ${seats.count} active member${seats.count === 1 ? '' : 's'}, more than the ${seats.limit}-seat limit on ${planName}. Deactivate members down to the new limit first, then switch plans.`,
          seatLimitExceeded: true,
        }, { status: 409 })
      }
      if (projects.over) {
        return NextResponse.json({
          error: `This workspace has ${projects.count} active project${projects.count === 1 ? '' : 's'}, more than the ${projects.limit}-project limit on ${planName}. Complete, archive or delete projects down to the new limit first, then switch plans.`,
          projectLimitExceeded: true,
        }, { status: 409 })
      }
    }

    const { data: user } = await (service as any)
      .from('users').select('email').eq('id', session.id).single()
    const email = user?.email || session.email

    await createPendingCheckout(service, {
      workspaceId: session.workspaceId, userId: session.id, email, planKey, interval, planCode,
    })

    return NextResponse.json({
      planCode,
      email,
      publicKey,
      // Kept for the popup, but the webhook treats it as a tie-break hint
      // only — the server-side checkout row is what binds the workspace.
      metadata: { workspaceId: session.workspaceId, planKey, interval, userId: session.id },
    })
  } catch (err) {
    console.error('Billing upgrade error:', err)
    return NextResponse.json({ error: 'Could not start checkout' }, { status: 500 })
  }
}
