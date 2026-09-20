export const runtime = 'nodejs'
// FEATURE (cron audit, section 17 — feature gap, closing pass): this loops
// per stale approval request with no pagination, the same unbounded-fan-
// out shape payment-overdue and reconciliation-rollup already carry an
// explicit override for — see either file's own comment for the full
// reasoning. Brought to parity rather than waiting for this one to
// actually time out first.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendApprovalReminder, documentLabelFor } from '@/lib/approvals/engine'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { APPROVAL_STALL_DAYS } from '@/lib/utils/attention'
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
            // FIX (Notifications & email fix round): this went to MANAGE_ROLES holders, but the fix
            // it asks for ("check the approval workflow's assignment") needs MANAGE_WORKSPACE_SETTINGS —
            // that is what gates the workflow editor and its API, and what lets someone open this
            // request in the Approvals "All" tab. A role-manager without it got an alert they
            // couldn't act on, while the people who could weren't told. (approval_send_failed_stale
            // below already targets the right permission.)
            workspaceId: r.workspace_id, permission: 'MANAGE_WORKSPACE_SETTINGS',
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

    // FIX (fix round, section-11 flagship finding): this cron only ever
    // looked at status='pending' requests — a request that fully cleared
    // approval but then failed to auto-send (status='approved',
    // send_failed_at set — migration 053) got zero automated reminders or
    // escalation, no matter how long it sat, unlike every other stall
    // pattern in this app. The dashboard, project pages, Sidebar badge and
    // Approvals page were all fixed elsewhere this round to surface it —
    // but all of those still require someone to go looking. This closes
    // the remaining gap: a proactive nudge, on the same cadence as an
    // ordinary stalled decision, to the people actually authorized to act
    // on it (the requester, or a MANAGE_WORKSPACE_SETTINGS admin — see
    // retry-send/route.ts's own authorization model).
    const { data: staleSendFailures } = await (service as any)
      .from('approval_requests')
      .select('id, workspace_id, project_id, requested_by, document_type, send_failed_reason, updated_at')
      .eq('status', 'approved')
      .not('send_failed_at', 'is', null)
      .lt('updated_at', cutoff)

    let sendFailureEscalated = 0
    for (const r of (staleSendFailures || [])) {
      try {
        await notifyMembersWithPermission(service, {
          workspaceId: r.workspace_id, permission: 'MANAGE_WORKSPACE_SETTINGS',
          eventType: 'approval_no_reachable_approver', type: 'approval_send_failed_stale',
          title: 'An approved document still hasn\u2019t been sent',
          body: `A ${documentLabelFor(r.document_type)} was approved ${threshold}+ days ago but couldn't be sent automatically (${r.send_failed_reason || 'send failed'}) and hasn't been retried.`,
          entityType: 'approval_request', entityId: r.id, projectId: r.project_id,
        })
        await (service as any).from('approval_requests')
          .update({ updated_at: now.toISOString() }).eq('id', r.id)
        await insertAuditRow(service, {
          workspace_id: r.workspace_id,
          actor_id:     null,
          actor_email:  'cron@scopegov.app',
          actor_name:   'ScopeGov',
          event_type:   'approval.send_failure_escalated',
          entity_type:  'approval_request',
          entity_id:    r.id,
          metadata:     { days_stale: threshold },
        })
        sendFailureEscalated++
      } catch (e) { console.error('Approval send-failure escalation error:', e) }
    }

    // FEATURE (cron audit, section 17 — feature gap, closing pass): see
    // migration 058 / lib/utils/cron-heartbeat.ts — recorded on success
    // only, so the watchdog can't be fooled by a cron that's merely
    // erroring on every run into thinking it's healthy.
    await recordCronHeartbeat(service, 'approval-stall', { reminded, escalated, sendFailureEscalated })
    return NextResponse.json({ ok: true, reminded, escalated, sendFailureEscalated })
  } catch (err) {
    console.error('Approval stall cron error:', err)
    // FEATURE (cron audit, section 17 — feature gap, closing pass): see
    // lib/utils/cron-alert.ts — this used to be console.error-only.
    await alertCronFailure(createServiceClient(), 'approval-stall', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET, not POST (see
// co-stall/route.ts for the full explanation) — alias so both work.
export const GET = POST
