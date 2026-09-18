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

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { sendGuardianFlagStalledEmail } from '@/lib/email/templates'

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service   = createServiceClient()
    const now       = new Date()
    // Same order of magnitude as co-stall's 5-day threshold — an open flag
    // is an active scope-governance question, not a fire-and-forget send,
    // so it's given a little more room than a signature nudge before this
    // treats it as stalled.
    const threshold = 5 // days
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()

    // updated_at doubles as "last activity on this flag" — it moves
    // forward on any status change and gets bumped here after a reminder,
    // so a flag that was just touched (or just reminded) won't be picked
    // up again until it's been quiet for the full window again.
    const { data: stale } = await (service as any)
      .from('guardian_flags')
      .select('id, workspace_id, project_id, severity, description, sow_reference, projects(id, name, clients(name))')
      .eq('status', 'open')
      .lt('updated_at', cutoff)

    let reminded = 0
    for (const flag of (stale || [])) {
      try {
        const project = flag.projects
        if (!project) continue

        const { data: updated } = await (service as any).from('guardian_flags')
          .update({ updated_at: now.toISOString() })
          .eq('id', flag.id).eq('status', 'open') // guard against this flag being resolved/converted between select and update
          .select('id')

        if (!updated || updated.length === 0) continue // lost the race — already actioned

        await (service as any).from('audit_log').insert({
          workspace_id: flag.workspace_id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'flag.reminder_sent', entity_type: 'guardian_flag',
          entity_id: flag.id, entity_name: project.name,
          metadata: { severity: flag.severity, days_open: threshold },
        })

        await notifyMembersWithPermission(service, {
          workspaceId: flag.workspace_id, permission: 'APPROVE_FLAGS', eventType: 'guardian_flag_stalled',
          type: 'guardian_flag_stalled', title: `Scope flag needs attention — ${project.name}`,
          body: `A ${flag.severity} flag on ${project.name} has been open ${threshold}+ days with no action.`,
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
            })
          }
        } catch (e) { console.error('Guardian flag stalled email failed:', e) }

        reminded++
      } catch (e) { console.error('Guardian flag stall error:', e) }
    }

    return NextResponse.json({ ok: true, reminded })
  } catch (err) {
    console.error('Guardian flag stall cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron Jobs invoke via GET; alias same as every other cron route here.
export const GET = POST
