import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { PLAN_LIMITS } from '@/lib/utils/format'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const { planKey, interval = 'monthly' } = await request.json()
    if (!planKey) return NextResponse.json({ error: 'planKey required' }, { status: 400 })

    // Map planKey + interval to Paystack plan code
    const envKey    = `PAYSTACK_PLAN_${planKey.toUpperCase()}_${interval.toUpperCase()}`
    const planCode  = process.env[envKey]
    if (!planCode)
      return NextResponse.json({ error: `Plan code not configured: ${envKey}` }, { status: 422 })

    const service = createServiceClient()

    // FIX (deep audit, Settings re-pass): PLAN_LIMITS' seat counts were
    // only ever used to render labels in this tab — nothing checked a
    // workspace's actual active-member count against the target plan's
    // seat limit before opening checkout, so a workspace could switch to
    // a tier with fewer seats than it currently has members, with no
    // warning about what happens to the members who no longer fit.
    // Checked here (not just client-side) since this is the one place
    // that's actually authoritative before money changes hands.
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

    // FIX (deep audit, Billing re-pass): the seat check above exists
    // precisely because nothing else guarded a downgrade against a
    // workspace no longer fitting the target plan's limits — but
    // PLAN_LIMITS[planKey].projects (api/projects/route.ts already
    // enforces this same limit at project-creation time, counting every
    // non-deleted project regardless of status) had no equivalent check
    // here at all. A workspace on Pro/Agency (unlimited projects) with
    // dozens of active projects could downgrade to Solo/Starter through
    // checkout with zero warning, pay for it, and immediately land in a
    // permanent "can't create any new project" state they were never told
    // about before money changed hands. Same reasoning, same place to
    // catch it, as the seat check right above.
    const targetProjects = PLAN_LIMITS[planKey]?.projects
    if (targetProjects != null) {
      const { count: activeProjects } = await (service as any)
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId)
        .is('deleted_at', null)
      if ((activeProjects || 0) > targetProjects) {
        return NextResponse.json({
          error: `This workspace has ${activeProjects} project${activeProjects === 1 ? '' : 's'}, more than the ${targetProjects}-project limit on ${PLAN_LIMITS[planKey]?.name || planKey}. Archive or delete projects down to the new limit first, then switch plans.`,
          projectLimitExceeded: true,
        }, { status: 409 })
      }
    }

    const { data: user } = await (service as any)
      .from('users').select('email').eq('id', session.id).single()

    return NextResponse.json({
      planCode,
      email:     user?.email || session.email,
      publicKey: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
      callbackUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing&upgraded=1`,
      metadata: {
        workspaceId: session.workspaceId,
        planKey,
        interval,
        userId: session.id,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
