export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendApprovalReminder } from '@/lib/approvals/engine'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { APPROVAL_STALL_DAYS } from '@/lib/utils/attention'

import { insertAuditRow } from '@/lib/utils/audit'
// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service   = createServiceClient()
    const now       = new Date()
    // Shorter window than co-stall's 5 days — an approval gate is blocking
    // a send that's otherwise ready to go out, not an open client
    // negotiation, so it's worth nudging sooner. Shared with
    // lib/utils/attention.ts so the dashboard's "needs attention" register
    // and this cron's reminder cadence can't silently drift apart.
    const threshold = APPROVAL_STALL_DAYS // days
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()

    // updated_at doubles as "last activity on this request" — it moves
    // forward on step-advance and gets bumped here after a reminder, so
    // a request that just changed step (or was just reminded) won't be
    // picked up again until it's been quiet for the full window again.
    const { data: stale } = await (service as any)
      .from('approval_requests')
      .select('id, workspace_id')
      .eq('status', 'pending')
      .lt('updated_at', cutoff)

    let reminded = 0
    let escalated = 0
    for (const r of (stale || [])) {
      try {
        const result = await sendApprovalReminder(service, r.id)
        if (result === 'sent') {
          await (service as any).from('approval_requests')
            .update({ updated_at: now.toISOString() }).eq('id', r.id)
          await insertAuditRow(service, {
            workspace_id: r.workspace_id,
            actor_id:     null,
            actor_email:  'cron@scopegov.app',
            actor_name:   'ScopeGov',
            event_type:   'approval.reminder_sent',
            entity_type:  'approval_request',
            entity_id:    r.id,
            metadata:     { days_pending: threshold },
          })
          reminded++
        } else if (result === 'no_recipients') {
          // FIX (cron audit, section 17): sendApprovalReminder used to
          // report success here regardless of whether anyone was actually
          // reachable — see the fix note there. A broken approver
          // assignment (role with no active holder, or a specific user no
          // longer active in this workspace) needs a human to fix the
          // assignment itself, not another silent retry. Tell whoever can
          // fix it (MANAGE_ROLES holders) and leave updated_at untouched
          // so this keeps surfacing daily — at this cron's own cadence,
          // not a spammier one — until the assignment is corrected.
          await insertAuditRow(service, {
            workspace_id: r.workspace_id,
            actor_id:     null,
            actor_email:  'cron@scopegov.app',
            actor_name:   'ScopeGov',
            event_type:   'approval.no_reachable_approver',
            entity_type:  'approval_request',
            entity_id:    r.id,
            metadata:     { days_pending: threshold },
          })
          await notifyMembersWithPermission(service, {
            workspaceId: r.workspace_id, permission: 'MANAGE_ROLES',
            eventType: 'approval_no_reachable_approver', type: 'approval_no_reachable_approver',
            title: 'Approval step has no reachable approver',
            body: `A pending approval has been stalled for ${threshold}+ days and its assigned approver (role or user) can't be reached — check the approval workflow's assignment.`,
            entityType: 'approval_request', entityId: r.id,
          })
          escalated++
        }
        // 'not_found' means the request/step/requester lookup itself came
        // back empty — an orphaned or already-resolved row race; nothing
        // to remind or escalate.
      } catch (e) { console.error('Approval reminder error:', e) }
    }

    return NextResponse.json({ ok: true, reminded, escalated })
  } catch (err) {
    console.error('Approval stall cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET, not POST (see
// co-stall/route.ts for the full explanation) — alias so both work.
export const GET = POST
