export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendTrialWarningEmail, sendPaymentFailedEmail } from '@/lib/email/templates'

function verifyCronSecret(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    const now     = new Date()

    // ── 1. Mark overdue payment milestones ─────────────────
    const { data: overdueMilestones } = await (service as any)
      .from('payment_milestones')
      .select('id')
      .eq('status', 'pending')
      .not('due_date', 'is', null)
      .lt('due_date', now.toISOString().split('T')[0])

    if (overdueMilestones?.length) {
      await (service as any).from('payment_milestones')
        .update({ status: 'overdue' })
        .in('id', overdueMilestones.map((m: any) => m.id))
    }

    // ── 2. Trial expiry enforcement ────────────────────────
    const { data: expiredTrials } = await (service as any)
      .from('workspaces')
      .select(`id, agency_name, plan_tier, trial_ends_at,
        billing(paystack_subscription_code),
        workspace_members!inner(user_id, status, users!inner(name, email))`)
      .eq('plan_tier', 'trial')
      .lt('trial_ends_at', now.toISOString())
      .is('deleted_at', null)

    for (const ws of (expiredTrials || [])) {
      try {
        if (ws.billing?.paystack_subscription_code) {
          // Has payment on file → convert to paid plan (handled by webhook)
          continue
        }

        // Downgrade to solo (3-day grace already passed)
        const trialExpired = new Date(ws.trial_ends_at)
        const graceDays    = Math.floor((now.getTime() - trialExpired.getTime()) / 86400000)

        if (graceDays >= 0) {
          // Check if already downgraded
          const { data: alreadyLogged } = await (service as any)
            .from('audit_log').select('id')
            .eq('workspace_id', ws.id).eq('event_type', 'billing.trial_expired').limit(1).single()

          if (!alreadyLogged) {
            // Convert to Solo (solo: 2 projects, 1 seat)
            await (service as any).from('workspaces')
              .update({ plan_tier: 'solo', updated_at: now.toISOString() })
              .eq('id', ws.id).eq('plan_tier', 'trial')

            await (service as any).from('audit_log').insert({
              workspace_id: ws.id, actor_id: null,
              actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
              event_type: 'billing.trial_expired', entity_type: 'workspace',
              entity_id: ws.id, entity_name: ws.agency_name,
              metadata: { converted_to: 'solo' },
            })

            // Notify owner (Event 27)
            const owner = (ws.workspace_members || [])
              .filter((m: any) => m.status === 'active')
              .map((m: any) => m.users)[0]
            if (owner) {
              await sendTrialWarningEmail({
                to: owner.email, name: owner.name, agencyName: ws.agency_name,
                daysLeft: 0,
                upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
              })
            }
          }
        }
      } catch (e) { console.error('Trial expiry error:', e) }
    }

    // ── 3. Grace period enforcement (5 days after payment failure) ─
    const graceCutoff = new Date(now.getTime() - 5 * 86400000).toISOString()
    const { data: graceExpired } = await (service as any)
      .from('billing')
      .select('workspace_id, workspaces(id,agency_name,plan_tier,workspace_members!inner(user_id,status,users!inner(name,email)))')
      .not('grace_period_started_at', 'is', null)
      .lt('grace_period_started_at', graceCutoff)

    for (const b of (graceExpired || [])) {
      try {
        const ws = b.workspaces
        if (!ws || ws.plan_tier === 'solo') continue

        await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id)

        await (service as any).from('billing')
          .update({ grace_period_started_at: null, paystack_subscription_code: null })
          .eq('workspace_id', b.workspace_id)

        await (service as any).from('audit_log').insert({
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.downgraded_for_nonpayment', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name, metadata: {},
        })

        // Event 29: send downgrade notification
        const owner = (ws.workspace_members || [])
          .filter((m: any) => m.status === 'active')
          .map((m: any) => m.users)[0]
        if (owner) {
          await sendPaymentFailedEmail({
            to: owner.email, name: owner.name, agencyName: ws.agency_name,
            upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            graceDaysLeft: 0,
          })
        }
      } catch (e) { console.error('Grace enforcement error:', e) }
    }

    return NextResponse.json({
      ok: true,
      overdueMarked: overdueMilestones?.length || 0,
      trialsExpired: expiredTrials?.length || 0,
    })
  } catch (err) {
    console.error('Payment overdue cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. The 3 sub-hourly jobs (sow-stall, co-stall, guardian-health) are
// triggered by the GitHub Actions workflow via POST, which still works.
// Exporting GET as an alias makes both invocation paths work.
export const GET = POST
