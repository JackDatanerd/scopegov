export const runtime = 'nodejs'
// FEATURE (cron audit, section 17 — feature gap, closing pass): per-row
// fan-out (an email per workspace member across every trialing workspace)
// with no pagination — same shape payment-overdue/reconciliation-rollup
// already carry this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendTrialWarningEmail } from '@/lib/email/templates'
import { filterByNotificationPreference } from '@/lib/utils/permissions-query'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

import { insertAuditRow } from '@/lib/utils/audit'
// FIX (audit round 3): local copy replaced with the shared helper — see
// lib/utils/verify-cron.ts (this route's original null-safe version is
// now the shared implementation every other cron route uses too).

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

      // FIX (cron audit, section 17): daysLeft can be 0 here for a trial
      // that has *already* passed trial_ends_at within the last 24h (this
      // query's own window includes yesterday) but that payment-overdue's
      // trial-expiry step (runs an hour later, 9am vs this route's 8am)
      // hasn't processed yet. Both routes send sendTrialWarningEmail with
      // daysLeft: 0 and near-identical subject lines, tracked under two
      // different, uncoordinated audit_log event types — so a workspace in
      // that narrow window could get both within the hour. This route is
      // the advance warning; the actual "trial has ended" moment (with the
      // real downgrade attached) belongs to payment-overdue alone.
      if (daysLeft <= 0) continue

      // FIX (re-audit, cron section): this is every active workspace
      // member (opted in by default), not specifically "the owner" —
      // filterByNotificationPreference already narrows it to whoever
      // hasn't opted out of trial_ending.
      const members: { id: string; name: string; email: string }[] = (ws.workspace_members || [])
        .filter((m: any) => m.status === 'active' && m.users)
        .map((m: any) => ({ id: m.user_id, name: m.users.name, email: m.users.email }))

      const enabledMembers = await filterByNotificationPreference(service, ws.id, 'trial_ending', members)

      for (const owner of enabledMembers) {
        try {
          // FIX (re-audit, cron section): the "already sent today" check
          // only scoped by workspace_id + event_type, not by recipient. In
          // a workspace with more than one active member opted into
          // trial_ending, the first member processed in this loop inserts
          // the audit_log row below — then every subsequent member in the
          // *same run* sees that row and gets skipped, because nothing here
          // distinguished "already sent to this workspace today" from
          // "already sent to THIS PERSON today". Only one member of any
          // multi-member workspace ever actually got the email. Matching
          // on metadata->>sent_to as well fixes that.
          const { data: alreadySent } = await (service as any)
            .from('audit_log')
            .select('id')
            .eq('workspace_id', ws.id)
            .eq('event_type', 'billing.trial_ending_soon')
            .eq('metadata->>sent_to', owner.email)
            .gte('created_at', new Date(now.getTime() - 24 * 3600000).toISOString())
            .limit(1)
            .maybeSingle()

          if (alreadySent) continue

          await sendTrialWarningEmail({
            to:         owner.email,
            name:       owner.name || owner.email,
            agencyName: ws.agency_name,
            daysLeft,
            upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
          })

          await insertAuditRow(service, {
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

    await recordCronHeartbeat(service, 'trial-warning', { sent })
    return NextResponse.json({ ok: true, sent })
  } catch (err) {
    console.error('Trial warning cron error:', err)
    await alertCronFailure(createServiceClient(), 'trial-warning', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. Exporting GET as an alias makes both invocation paths work.
//
// FIX (build, cron/portal audit round): the 3 sub-hourly jobs (sow-stall,
// co-stall, guardian-health) are now scheduled directly in vercel.json
// AND kept in .github/workflows/vercel-crons.yml as a redundant trigger
// (see that file's own comment for why both are kept intentionally) —
// this comment previously implied GitHub Actions was the only path,
// which stopped being true once vercel.json picked these three up too.
export const GET = POST
