export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendTrialWarningEmail } from '@/lib/email/templates'
import { filterByNotificationPreference } from '@/lib/utils/permissions-query'

// BUG-036: all cron routes require CRON_SECRET
function verifyCronSecret(request: NextRequest): boolean {
  const auth   = request.headers.get('authorization')
  const secret = process.env.CRON_SECRET
  if (!secret) { console.error('CRON_SECRET not set'); return false }
  return auth === `Bearer ${secret}`
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    const now     = new Date()

    // Find trial workspaces expiring in the next 3 days with no subscription on file
    const soon      = new Date(now.getTime() + 3 * 86400000).toISOString()
    const yesterday = new Date(now.getTime() - 86400000).toISOString()

    const { data: workspaces } = await (service as any)
      .from('workspaces')
      .select(`id, agency_name, trial_ends_at,
        billing(paystack_subscription_code),
        workspace_members!inner(user_id, status,
          users!inner(name, email))`)
      .eq('plan_tier', 'trial')
      .is('deleted_at', null)
      .lte('trial_ends_at', soon)
      .gte('trial_ends_at', yesterday)

    let sent = 0
    for (const ws of (workspaces || [])) {
      // Skip if they already have a subscription
      if (ws.billing?.paystack_subscription_code) continue

      const daysLeft = Math.max(0, Math.ceil(
        (new Date(ws.trial_ends_at).getTime() - now.getTime()) / 86400000
      ))

      // Find workspace owner
      const owners: { id: string; name: string; email: string }[] = (ws.workspace_members || [])
        .filter((m: any) => m.status === 'active' && m.users)
        .map((m: any) => ({ id: m.user_id, name: m.users.name, email: m.users.email }))

      const enabledOwners = await filterByNotificationPreference(service, ws.id, 'trial_ending', owners)

      for (const owner of enabledOwners) {
        try {
          // Check if warning already sent (simple audit log check)
          const { data: alreadySent } = await (service as any)
            .from('audit_log')
            .select('id')
            .eq('workspace_id', ws.id)
            .eq('event_type', 'billing.trial_ending_soon')
            .gte('created_at', new Date(now.getTime() - 24 * 3600000).toISOString())
            .limit(1)
            .single()

          if (alreadySent) continue

          await sendTrialWarningEmail({
            to:         owner.email,
            name:       owner.name || owner.email,
            agencyName: ws.agency_name,
            daysLeft,
            upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
          })

          await (service as any).from('audit_log').insert({
            workspace_id: ws.id,
            actor_id:     null,
            actor_email:  'cron@scopegov.app',
            actor_name:   'ScopeGov',
            event_type:   'billing.trial_ending_soon',
            entity_type:  'workspace',
            entity_id:    ws.id,
            entity_name:  ws.agency_name,
            metadata:     { days_left: daysLeft, sent_to: owner.email },
          })
          sent++
        } catch (e) { console.error('Trial warning email failed:', e) }
      }
    }

    return NextResponse.json({ ok: true, sent })
  } catch (err) {
    console.error('Trial warning cron error:', err)
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
