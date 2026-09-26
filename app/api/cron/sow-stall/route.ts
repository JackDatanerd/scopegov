export const runtime = 'nodejs'
// Unbounded per-row fan-out — same override payment-overdue and reconciliation-rollup carry.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { sendSowStalledEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { insertAuditRow } from '@/lib/utils/audit'
import { CronRun, fetchAll } from '@/lib/utils/cron-run'
import { viewedNote } from '@/lib/utils/viewed'
import { checkedSend } from '@/lib/email/delivery'

// Hourly. Marks a project 'Stalled' when its SOW has sat unsigned for 7 days and tells the team.
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const run = new CronRun(service, 'sow-stall')
  let stalled = 0

  await run.step('stall unsigned SOWs', async () => {
    const now       = new Date()
    const threshold = 7 // days — configurable per workspace in future
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()

    // `!inner` is what makes `projects.status` actually restrict the parent rows under PostgREST.
    const staleSOWs = await fetchAll<any>('sow-stall select', (from, to) =>
      (service as any)
        .from('sow_documents')
        .select('id, project_id, workspace_id, sent_at, first_viewed_at, projects!inner(id, name, status, clients(name))')
        .eq('status', 'awaiting_signature')
        .lt('sent_at', cutoff)
        .eq('projects.status', 'Awaiting Signature')
        .order('id')
        .range(from, to))

    for (const sow of staleSOWs) {
      if (!sow.projects) continue
      try {
        const { data: updated, error: updErr } = await (service as any).from('projects').update({
          status:       'Stalled',
          stall_reason: 'sow_unsigned',
          updated_at:   now.toISOString(),
        }).eq('id', sow.project_id).eq('status', 'Awaiting Signature').select('id')
        if (updErr) throw new Error(updErr.message)
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
          metadata:     { sow_id: sow.id, days_since_sent: threshold, viewed: !!sow.first_viewed_at },
        })

        const projectName = sow.projects?.name || 'Untitled project'
        const clientName  = sow.projects?.clients?.name || 'Client'
        const projectUrl  = `${process.env.NEXT_PUBLIC_APP_URL}/projects/${sow.project_id}?tab=sow`
        const seen        = viewedNote(sow.first_viewed_at)

        await notifyMembersWithPermission(service, {
          workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_stalled',
          type: 'sow_stalled', title: `SOW stalled — ${projectName}`,
          body: `${clientName} hasn't signed the SOW for ${projectName} in ${threshold}+ days. ${seen}`.trim(),
          entityType: 'project', entityId: sow.project_id, projectId: sow.project_id,
        })

        try {
          const emails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, 'sow_stalled', sow.project_id)
          if (emails.length) {
            // FIX (re-audit, section 17): raw try/catch, not checkedSend — same missing-check class
            // of bug as the rest of this cron section; see co-stall's identical fix for the writeup.
            await checkedSend(() => sendSowStalledEmail({
              to: emails, clientName, projectName,
              daysSinceSent: threshold, projectUrl, viewedNote: seen,
            }), 'SOW stalled email')
          }
        } catch (e) { console.error('SOW stalled email failed:', e) }

        stalled++
      } catch (e) { run.rowError(`sow ${sow.id}`, e) }
    }
    run.result.stalled = stalled
  })

  const { body, status } = await run.finish()
  return NextResponse.json(body, { status })
}

// Vercel Cron invokes the configured path with GET; the GitHub Actions backup uses POST.
export const GET = POST
