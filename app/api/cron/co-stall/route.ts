export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { sendCoStalledEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service   = createServiceClient()
    const now       = new Date()
    const threshold = 5 // days — spec default
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()

    // BUG-055: ONLY awaiting_response. 'countered' COs do NOT auto-stall.
    // A countered CO has an active negotiation — stalling it makes no sense.
    // FIX (build, cron section): joined project/client here — stalling a
    // CO used to be a pure status flip with zero outbound signal (no email,
    // no in-app notification), just an audit-log row nobody would see
    // unless they happened to check the dashboard. For a product whose
    // whole premise is not letting things go silently stale, that was a
    // real gap. Need project name + client name for the new notification.
    // FIX (re-audit): change_orders has no `deleted_at` column — it was
    // never added in any migration. Filtering on it made PostgREST reject
    // the query outright (42703, column does not exist) on every single
    // run; since only `data` was destructured (error silently discarded),
    // this cron has been returning `{ok:true, stalled:0}` while doing
    // nothing at all, every time it's run since the feature shipped —
    // including the notification wiring added just above, which has
    // therefore never actually fired either.
    const { data: staleCOs } = await (service as any)
      .from('change_orders')
      .select('id, title, project_id, workspace_id, sent_at, projects(name, clients(name))')
      .eq('status', 'awaiting_response')  // NOT countered
      .lt('sent_at', cutoff)

    let stalled = 0
    for (const co of (staleCOs || [])) {
      try {
        const { data: updated } = await (service as any).from('change_orders').update({
          status:     'stalled',
          updated_at: now.toISOString(),
        }).eq('id', co.id).eq('status', 'awaiting_response').select('id') // double-check status hasn't changed

        if (!updated?.length) continue // lost the race to a concurrent status change — nothing else to do

        await (service as any).from('audit_log').insert({
          workspace_id: co.workspace_id,
          actor_id:     null,
          actor_email:  'cron@scopegov.app',
          actor_name:   'ScopeGov',
          event_type:   'co.marked_stalled',
          entity_type:  'change_order',
          entity_id:    co.id,
          entity_name:  co.title,
          metadata:     { days_since_sent: threshold },
        })

        const projectName = co.projects?.name || 'Untitled project'
        const clientName  = co.projects?.clients?.name || 'Client'
        const projectUrl  = `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`

        await notifyMembersWithPermission(service, {
          workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_stalled',
          type: 'co_stalled', title: `Change order stalled — ${co.title}`,
          body: `${clientName} hasn't responded to "${co.title}" on ${projectName} in ${threshold}+ days.`,
          entityType: 'project', entityId: co.project_id, projectId: co.project_id,
        })

        try {
          const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_stalled', co.project_id)
          if (emails.length) {
            await sendCoStalledEmail({
              to: emails, clientName, projectName, coTitle: co.title,
              daysSinceSent: threshold, projectUrl,
            })
          }
        } catch (e) { console.error('CO stalled email failed:', e) }

        stalled++
      } catch (e) { console.error('CO stall error:', e) }
    }

    return NextResponse.json({ ok: true, stalled })
  } catch (err) {
    console.error('CO stall cron error:', err)
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
