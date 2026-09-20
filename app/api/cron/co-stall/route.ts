export const runtime = 'nodejs'
// Unbounded per-row fan-out — same override payment-overdue and reconciliation-rollup carry.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { sendCoStalledEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { insertAuditRow } from '@/lib/utils/audit'
import { CronRun, fetchAll } from '@/lib/utils/cron-run'
import { viewedNote } from '@/lib/utils/viewed'

// Hourly. Marks an unanswered change order 'stalled' after 5 days and tells the team.
// (A stalled CO stays respondable by the client — 'stalled' is an agency-side attention flag.)
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const run = new CronRun(service, 'co-stall')
  let stalled = 0

  await run.step('stall unanswered change orders', async () => {
    const now       = new Date()
    const threshold = 5 // days — spec default
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()

    // ONLY awaiting_response — a 'countered' CO is an active negotiation and must not auto-stall.
    // (change_orders has no `deleted_at`; filtering on it made every run a silent no-op once.)
    // fetchAll throws on a query error instead of reporting "0 stalled" and a green heartbeat.
    const staleCOs = await fetchAll<any>('co-stall select', (from, to) =>
      (service as any)
        .from('change_orders')
        .select('id, title, project_id, workspace_id, sent_at, first_viewed_at, projects(name, clients(name))')
        .eq('status', 'awaiting_response')
        .lt('sent_at', cutoff)
        .order('id')
        .range(from, to))

    for (const co of staleCOs) {
      try {
        const { data: updated, error: updErr } = await (service as any).from('change_orders').update({
          status:     'stalled',
          updated_at: now.toISOString(),
        }).eq('id', co.id).eq('status', 'awaiting_response').select('id') // status hasn't changed underneath us
        if (updErr) throw new Error(updErr.message)
        if (!updated?.length) continue // lost the race to a concurrent status change

        await insertAuditRow(service, {
          workspace_id: co.workspace_id,
          actor_id:     null,
          actor_email:  'cron@scopegov.app',
          actor_name:   'ScopeGov',
          event_type:   'co.marked_stalled',
          entity_type:  'change_order',
          entity_id:    co.id,
          entity_name:  co.title,
          metadata:     { days_since_sent: threshold, viewed: !!co.first_viewed_at },
        })

        const projectName = co.projects?.name || 'Untitled project'
        const clientName  = co.projects?.clients?.name || 'Client'
        const projectUrl  = `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`
        const seen        = viewedNote(co.first_viewed_at)

        await notifyMembersWithPermission(service, {
          workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_stalled',
          type: 'co_stalled', title: `Change order stalled — ${co.title}`,
          body: `${clientName} hasn't responded to "${co.title}" on ${projectName} in ${threshold}+ days. ${seen}`.trim(),
          entityType: 'project', entityId: co.project_id, projectId: co.project_id,
        })

        try {
          const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_stalled', co.project_id)
          if (emails.length) {
            await sendCoStalledEmail({
              to: emails, clientName, projectName, coTitle: co.title,
              daysSinceSent: threshold, projectUrl, viewedNote: seen,
            })
          }
        } catch (e) { console.error('CO stalled email failed:', e) }

        stalled++
      } catch (e) { run.rowError(`co ${co.id}`, e) }
    }
    run.result.stalled = stalled
  })

  const { body, status } = await run.finish()
  return NextResponse.json(body, { status })
}

// Vercel Cron invokes the configured path with GET; the GitHub Actions backup uses POST.
export const GET = POST
