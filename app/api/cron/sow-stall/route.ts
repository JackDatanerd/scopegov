export const runtime = 'nodejs'
// FEATURE (cron audit, section 17 — feature gap, closing pass): unbounded
// per-row fan-out with no pagination, same shape payment-overdue and
// reconciliation-rollup already carry this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { sendSowStalledEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

import { insertAuditRow } from '@/lib/utils/audit'
// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service   = createServiceClient()
    const now       = new Date()
    const threshold = 7 // days — configurable per workspace in future
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()

    // Find SOWs awaiting signature past the stall threshold
    // FIX (build, cron section): pulled in clients(name) for the new
    // notification below — same "zero outbound signal" gap as co-stall,
    // this used to be a pure status flip nobody would ever see unless
    // they happened to check the dashboard.
    //
    // FIX (build, cron/portal audit round): `.eq('projects.status', ...)`
    // on a default (left-joined) embed doesn't restrict the parent rows
    // under PostgREST — only `!inner` does. Without it this filter was a
    // no-op on the query itself: it fetched every awaiting_signature SOW
    // regardless of project status and relied entirely on the `.eq('id',
    // ...).eq('status', 'Awaiting Signature')` guard on the UPDATE below
    // to skip the wrong ones — correct in outcome, but not what the
    // select's own filter claimed to be doing, and needlessly wide.
    // `!inner` makes the select itself do the narrowing.
    const { data: staleSOWs } = await (service as any)
      .from('sow_documents')
      .select('id, project_id, workspace_id, sent_at, projects!inner(id, name, status, clients(name))')
      .eq('status', 'awaiting_signature')
      .lt('sent_at', cutoff)
      .eq('projects.status', 'Awaiting Signature')

    let stalled = 0
    for (const sow of (staleSOWs || [])) {
      if (!sow.projects) continue
      try {
        const { data: updated } = await (service as any).from('projects').update({
          status:       'Stalled',
          stall_reason: 'sow_unsigned',
          updated_at:   now.toISOString(),
        }).eq('id', sow.project_id).eq('status', 'Awaiting Signature').select('id')

        if (!updated?.length) continue // lost the race — project status already moved on

        await insertAuditRow(service, {
          workspace_id: sow.workspace_id,
          actor_id:     null,
          actor_email:  'cron@scopegov.app',
          actor_name:   'ScopeGov',
          event_type:   'sow.marked_stalled',
          entity_type:  'project',
          entity_id:    sow.project_id,
          entity_name:  sow.projects?.name,
          metadata:     { sow_id: sow.id, days_since_sent: threshold },
        })

        const projectName = sow.projects?.name || 'Untitled project'
        const clientName  = sow.projects?.clients?.name || 'Client'
        const projectUrl  = `${process.env.NEXT_PUBLIC_APP_URL}/projects/${sow.project_id}?tab=sow`

        await notifyMembersWithPermission(service, {
          workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_stalled',
          type: 'sow_stalled', title: `SOW stalled — ${projectName}`,
          body: `${clientName} hasn't signed the SOW for ${projectName} in ${threshold}+ days.`,
          entityType: 'project', entityId: sow.project_id, projectId: sow.project_id,
        })

        try {
          const emails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, 'sow_stalled', sow.project_id)
          if (emails.length) {
            await sendSowStalledEmail({
              to: emails, clientName, projectName,
              daysSinceSent: threshold, projectUrl,
            })
          }
        } catch (e) { console.error('SOW stalled email failed:', e) }

        stalled++
      } catch (e) { console.error('SOW stall error:', e) }
    }

    await recordCronHeartbeat(service, 'sow-stall', { stalled })
    return NextResponse.json({ ok: true, stalled })
  } catch (err) {
    console.error('SOW stall cron error:', err)
    await alertCronFailure(createServiceClient(), 'sow-stall', err).catch(() => {})
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
