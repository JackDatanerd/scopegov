import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { LIMIT_COUNTED_STATUSES } from '@/lib/utils/project-status'
import { parsePlanRequest, planCodeFor } from '@/lib/billing/plans'
import { createPendingCheckout } from '@/lib/billing/checkouts'

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
// FIX (re-audit, Billing section): this had no step-up (recent-MFA/
// re-authentication) guard, unlike billing/cancel right next to it — but
// this route isn't only "upgrade" despite its name: it accepts ANY paid
// tier, including switching to a cheaper one, and per the subscription.create
// webhook handler, completing that checkout DISABLES the workspace's current
// live subscription, the same real-world effect billing/cancel has. It's
// also the entry point for a brand-new charge. A stolen or long-idle aal2
// session (which, per lib/auth/step-up.ts, persists at aal2 for the whole
// life of the session) could silently swap or downgrade a workspace's paid
// plan with no fresh proof of identity, right next to a sibling endpoint
// that already requires one for a less-drastic action.
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp

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

    const service = createServiceClient()

    // Already on exactly this plan + interval with a healthy, renewing
    // subscription: nothing to buy.
    const [{ data: ws }, { data: billing }] = await Promise.all([
      (service as any).from('workspaces').select('plan_tier').eq('id', session.workspaceId).maybeSingle(),
      (service as any).from('billing')
        .select('paystack_subscription_code, plan_interval, cancels_at_period_end, grace_period_started_at')
        .eq('workspace_id', session.workspaceId).maybeSingle(),
    ])
    if (
      ws?.plan_tier === planKey && billing?.paystack_subscription_code &&
      billing.plan_interval === interval && !billing.cancels_at_period_end && !billing.grace_period_started_at
    ) {
      return NextResponse.json({ error: `This workspace is already on the ${PLAN_LIMITS[planKey]?.name} plan (${interval}).`, alreadyOnPlan: true }, { status: 409 })
    }

    // FIX (deep audit, Settings re-pass): seat limit checked server-side,
    // authoritatively, before money changes hands.
    const targetSeats = PLAN_LIMITS[planKey]?.seats
    if (targetSeats != null) {
      const { count: activeMembers } = await (service as any)
        .from('workspace_members')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId)
        .eq('status', 'active')
      if ((activeMembers || 0) > targetSeats) {
        return NextResponse.json({
          error: `This workspace has ${activeMembers} active member${activeMembers === 1 ? '' : 's'}, more than the ${targetSeats}-seat limit on ${PLAN_LIMITS[planKey]?.name || planKey}. Deactivate members down to the new limit first, then switch plans.`,
          seatLimitExceeded: true,
        }, { status: 409 })
      }
    }

    // FIX (deep audit, Billing re-pass): same for the project limit.
    const targetProjects = PLAN_LIMITS[planKey]?.projects
    if (targetProjects != null) {
      const { count: activeProjects } = await (service as any)
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId)
        .is('deleted_at', null)
        // Same rule as POST /api/projects: only live projects count toward the
        // allowance ("Active projects" on the pricing table). Complete/Archived
        // used to count here, so the advice below could never get anyone under
        // the limit (archiving didn't change the number).
        .in('status', [...LIMIT_COUNTED_STATUSES])
      if ((activeProjects || 0) > targetProjects) {
        return NextResponse.json({
          error: `This workspace has ${activeProjects} active project${activeProjects === 1 ? '' : 's'}, more than the ${targetProjects}-project limit on ${PLAN_LIMITS[planKey]?.name || planKey}. Complete, archive or delete projects down to the new limit first, then switch plans.`,
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
      publicKey: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
      // Kept for the popup, but the webhook treats it as a tie-break hint
      // only — the server-side checkout row is what binds the workspace.
      metadata: { workspaceId: session.workspaceId, planKey, interval, userId: session.id },
    })
  } catch (err) {
    console.error('Billing upgrade error:', err)
    return NextResponse.json({ error: 'Could not start checkout' }, { status: 500 })
  }
}
