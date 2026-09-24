export const runtime = 'nodejs'

// FEATURE (cron audit, section 17 — flagship finding): approval-stall,
// co-stall, and sow-stall all exist to nudge a human when something is
// sitting idle and needs attention. guardian_flags — the product's own
// core primitive, the thing ScopeGov is named for — had no equivalent:
// an open flag could sit unactioned indefinitely with zero automated
// escalation, only ever passively counted in scope-health-rollup's daily
// metrics rather than surfaced as something to actually go deal with.
// This closes that gap the same way the other three do: a reminder once
// a flag has sat 'open' for the threshold, with updated_at bumped on
// reminder so this doesn't re-fire every single day afterward.
//
// FIX (deep audit, section 13 — flagship finding): this only ever covered
// status='open'. But 'borderline_review' flags need a human to confirm or
// dismiss them just as much as an open flag needs resolving — the
// project-page UI itself treats the two as equally "needs review" (see
// ProjectDetail.tsx's needsReviewFlags) — and nothing else in the app ever
// reminds on them. A borderline item could sit forever with zero
// automated follow-up, which is exactly the gap this cron exists to
// close, just half of it. Covering both statuses here.

import { isTerminalStatus } from '@/lib/utils/project-status'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { sendGuardianFlagStalledEmail } from '@/lib/email/templates'

import { insertAuditRow } from '@/lib/utils/audit'
import { fetchAll, CronRun } from '@/lib/utils/cron-run'
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let service: any
  try {
    service = createServiceClient()
    // FIX (cron/portal audit round 3): moved onto CronRun — see sow-expiry. The reminder bump below
    // ignored its `error`, so a failing UPDATE looked like "lost the race" and the run stayed green.
    const run = new CronRun(service, 'guardian-flag-stall')
    const now       = new Date()
    // Same order of magnitude as co-stall's 5-day threshold — an open flag is an active
    // scope-governance question, not a fire-and-forget send, so it's given a little more room than a
    // signature nudge before this treats it as stalled.
    const threshold = 5 // days
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()
    let reminded = 0
    run.result.reminded = 0

    await run.step('remind stale flags', async () => {
      // updated_at doubles as "last activity on this flag" — it moves forward on any status change and
      // gets bumped here after a reminder, so a flag that was just touched (or just reminded) won't be
      // picked up again until it's been quiet for the full window again.
      //
      // FIX (cron/portal audit round 3): flags on finished or deleted projects were only skipped
      // inside the loop, so they were re-fetched by every run forever — the candidate set only ever
      // grew toward fetchAll's row ceiling, at which point live flags past it would silently never be
      // reminded. Excluded in the query now (the in-loop check stays as a backstop).
      const stale = await fetchAll<any>('guardian-flag-stall select', (from, to) =>
        (service as any)
          .from('guardian_flags')
          .select('id, workspace_id, project_id, status, severity, description, sow_reference, projects!inner(id, name, status, deleted_at, clients(name))')
          .in('status', ['open', 'borderline_review'])
          .lt('updated_at', cutoff)
          .is('projects.deleted_at', null)
          .not('projects.status', 'in', '(Complete,Archived)')
          .order('id')
          .range(from, to))

      for (const flag of stale) {
        try {
          const project = flag.projects
          if (!project) continue
          if (project.deleted_at || isTerminalStatus(project.status)) continue
          const isBorderline = flag.status === 'borderline_review'

          const { data: updated, error: updErr } = await (service as any).from('guardian_flags')
            .update({ updated_at: now.toISOString() })
            .eq('id', flag.id).eq('status', flag.status) // guard against this flag being actioned between select and update
            .select('id')
          if (updErr) throw new Error(`reminder bump failed: ${updErr.message}`)
          if (!updated || updated.length === 0) continue // lost the race — already actioned

          await insertAuditRow(service, {
            workspace_id: flag.workspace_id, actor_id: null,
            actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
            event_type: 'flag.reminder_sent', entity_type: 'guardian_flag',
            entity_id: flag.id, entity_name: project.name,
            metadata: { severity: flag.severity, status: flag.status, days_open: threshold },
          })

          await notifyMembersWithPermission(service, {
            workspaceId: flag.workspace_id, permission: 'APPROVE_FLAGS', eventType: 'guardian_flag_stalled',
            type: 'guardian_flag_stalled',
            title: isBorderline
              ? `Borderline item needs review — ${project.name}`
              : `Scope flag needs attention — ${project.name}`,
            body: isBorderline
              ? `A borderline scope item on ${project.name} has been awaiting review ${threshold}+ days with no action.`
              : `A ${flag.severity} flag on ${project.name} has been open ${threshold}+ days with no action.`,
            entityType: 'project', entityId: project.id, projectId: project.id,
          })

          try {
            const emails = await getMemberEmailsWithPermission(service, flag.workspace_id, 'APPROVE_FLAGS', 25, 'guardian_flag_stalled', project.id)
            if (emails.length) {
              await sendGuardianFlagStalledEmail({
                to: emails,
                projectName: project.name,
                clientName: project.clients?.name || 'Client',
                severity: flag.severity,
                description: flag.description,
                daysOpen: threshold,
                projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=guardian`,
                isBorderline,
              })
            }
          } catch (e) { run.rowError(`flag ${flag.id} reminder email`, e) }

          reminded++
        } catch (e) { run.rowError(`flag ${flag.id} reminder`, e) }
      }
      run.result.reminded = reminded
    })

    const { body, status } = await run.finish()
    return NextResponse.json(body, { status })
  } catch (err) {
    console.error('Guardian flag stall cron error:', err)
    await alertCronFailure(service ?? createServiceClient(), 'guardian-flag-stall', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron Jobs invoke via GET; alias same as every other cron route here.
export const GET = POST
