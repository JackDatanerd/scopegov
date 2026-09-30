export const runtime = 'nodejs'
// Loops per stale approval request — same unbounded-fan-out shape payment-overdue and
// reconciliation-rollup carry this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendApprovalReminder, documentLabelFor, healStuckSends } from '@/lib/approvals/engine'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { APPROVAL_STALL_DAYS } from '@/lib/utils/attention'
import { insertAuditRow } from '@/lib/utils/audit'
import { CronRun, fetchAll } from '@/lib/utils/cron-run'

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const run = new CronRun(service, 'approval-stall')
  const now = new Date()
  // Shorter window than co-stall's 5 days — an approval gate blocks a send that's otherwise ready
  // to go, so it's worth nudging sooner. Shared with lib/utils/attention.ts so the dashboard's
  // "needs attention" register and this cron can't drift apart.
  const threshold = APPROVAL_STALL_DAYS // days
  const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()
  let reminded = 0, escalated = 0, sendFailureEscalated = 0, healed = 0, unresponsiveEscalated = 0, notFound = 0

  // FIX (section-11 audit, pass 2): reminders repeated forever with no
  // escalation for an approver who WAS reachable but never acted, and the
  // "no reachable approver" alert re-fired (bell + audit row) on every run for
  // as long as the request sat there. Both now use the request's own counters.
  const ESCALATE_AFTER_REMINDERS = 3
  const REALERT_AFTER_MS = 7 * 86400000

  // Step 0 — a request parked in its "sending" state by a process that died mid-send.
  await run.step('heal stuck sends', async () => {
    const fixed = await healStuckSends(service)
    for (const r of fixed) {
      await insertAuditRow(service, {
        workspace_id: r.workspace_id, actor_id: null, project_id: r.project_id,
        actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
        event_type: 'approval.send_failed_stale', entity_type: 'approval_request', entity_id: r.id,
        metadata: { reason: 'send did not finish; request moved to the retryable approved-not-sent state' },
      })
      healed++
    }
  })

  // Step 1 — pending decisions that have gone quiet.
  // updated_at is this cron's quiet-window marker: it moves on step-advance and is bumped here after a
  // reminder, so a request only comes back after a full quiet window. It is NOT the "how long has this
  // step been waiting" clock — that is step_started_at (migration 110), which the dashboard/projects
  // attention flags read so a reminder doesn't hide a still-stuck request.
  // (A request with no reachable approver is deliberately NOT bumped so it keeps surfacing; the
  // old unpaginated query let those rows fill the first page forever and starve everything after
  // them — fetchAll pages through all of them.)
  await run.step('remind pending approvals', async () => {
    // FIX (section-11 audit): neither this query nor the send-failure one below excluded a
    // suspended/deleted workspace (workspaces.deleted_at) — a stalled approval in one kept
    // generating reminders, escalation notifications and "no reachable approver" audit rows
    // indefinitely, with nobody able (or expected) to act on a workspace nobody can open.
    const stale = await fetchAll<any>('approval-stall pending select', (from, to) =>
      (service as any).from('approval_requests')
        .select('id, workspace_id, project_id, document_type, context, reminder_count, escalated_at, workspaces!inner(deleted_at)')
        .eq('status', 'pending')
        .is('sending_started_at', null)
        .lt('updated_at', cutoff)
        .is('workspaces.deleted_at', null)
        .order('id')
        .range(from, to))

    for (const r of stale) {
      try {
        const result = await sendApprovalReminder(service, r.id)
        if (result === 'sent') {
          const reminderCount = (r.reminder_count || 0) + 1
          // FIX (cron/portal audit round 3): this update's result was never read. If it failed, updated_at
          // never moved, so the request came straight back next run and the approver was re-reminded every
          // day (and reminder_count never reached the escalation threshold) with nothing reporting it.
          const { error: bumpErr } = await (service as any).from('approval_requests')
            .update({ updated_at: now.toISOString(), reminder_count: reminderCount }).eq('id', r.id)
          if (bumpErr) throw new Error(`reminder bookkeeping failed (the approver WAS reminded): ${bumpErr.message}`)
          await insertAuditRow(service, {
            workspace_id: r.workspace_id, actor_id: null, project_id: r.project_id,
            actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
            event_type: 'approval.reminder_sent', entity_type: 'approval_request', entity_id: r.id,
            metadata: { days_pending: threshold, reminder_count: reminderCount },
          })
          reminded++

          // Reachable but unresponsive: after N reminders, tell the people who can
          // reassign the step instead of nudging the same approver indefinitely.
          // FIX (cron/portal audit round 3): `escalated_at` used to mean two different things — "the
          // approver was reachable but unresponsive" (here) AND "nobody could be reached" (the branch
          // below) — so a request that had once raised the no-approver alert could never get this
          // escalation (the guard below saw `escalated_at` set), and the reverse muted the no-approver
          // alert for 7 days. `escalated_at` now means only this escalation; the no-approver alert
          // dedupes on its own audit rows. The claim is taken BEFORE notifying (CAS on escalated_at IS
          // NULL) so a failed bookkeeping write can't re-notify the admins every run.
          if (reminderCount >= ESCALATE_AFTER_REMINDERS && !r.escalated_at) {
            const { data: claimed, error: claimErr } = await (service as any).from('approval_requests')
              .update({ escalated_at: now.toISOString() }).eq('id', r.id).is('escalated_at', null).select('id')
            if (claimErr) throw new Error(`escalation claim failed: ${claimErr.message}`)
            if (claimed?.length) {
              const escNotified = await notifyMembersWithPermission(service, {
                workspaceId: r.workspace_id, permission: 'MANAGE_WORKSPACE_SETTINGS',
                eventType: 'approval_no_reachable_approver', type: 'approval_unresponsive',
                title: 'An approval is still waiting on its approver',
                body: `A ${documentLabelFor(r.document_type)} approval has been waiting through ${reminderCount} reminders. You can reassign the step from the Approvals page.`,
                entityType: 'approval_request', entityId: r.id, projectId: r.project_id,
              })
              // FIX (cron section 17, pass 4 — B4): the escalation was claimed (escalated_at) before notifying, so a lost
              // bell is never retried — surface it.
              if (!escNotified) run.rowError(`approval ${r.id}`, new Error('escalation recorded but the admin bell notification failed to write'))
              await insertAuditRow(service, {
                workspace_id: r.workspace_id, actor_id: null, project_id: r.project_id,
                actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
                event_type: 'approval.escalated', entity_type: 'approval_request', entity_id: r.id,
                metadata: { reminder_count: reminderCount },
              })
              unresponsiveEscalated++
            }
          }
        } else if (result === 'no_recipients') {
          // Alert once a week per request, not on every run — deduped on the audit trail of THIS alert
          // (see the escalated_at note above). A failed lookup must not read as "never alerted".
          const since = new Date(now.getTime() - REALERT_AFTER_MS).toISOString()
          const { data: recent, error: recentErr } = await (service as any).from('audit_log').select('id')
            .eq('workspace_id', r.workspace_id).eq('event_type', 'approval.no_reachable_approver')
            .eq('entity_id', r.id).gte('created_at', since).limit(1).maybeSingle()
          if (recentErr) throw new Error(`no-approver dedupe lookup failed: ${recentErr.message}`)
          if (recent) continue
          // A broken approver assignment (role with no active holder, or a user no longer active)
          // needs a human to fix the assignment, not another silent retry.
          // FIX (cron section 17, pass 2): this audit row IS the dedupe marker, and insertAuditRow reports a
          // failed write by returning false (it never throws) — the result was ignored, so with audit_log
          // failing the alert re-fired every day instead of weekly. Marker first; if it can't be written,
          // skip the notification and retry next run (same discipline retainer-milestones uses).
          const marked = await insertAuditRow(service, {
            workspace_id: r.workspace_id, actor_id: null, project_id: r.project_id,
            actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
            event_type: 'approval.no_reachable_approver', entity_type: 'approval_request', entity_id: r.id,
            metadata: { days_pending: threshold },
          })
          if (!marked) throw new Error('could not record approval.no_reachable_approver (dedupe marker) — alert withheld, will retry next run')
          const noApproverNotified = await notifyMembersWithPermission(service, {
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
            // FIX (section-11 audit, independent pass — B4): projectId was omitted here while the other two
            // alerts in this file pass it, so the recipients weren't scoped to people who can open the request.
            entityType: 'approval_request', entityId: r.id, projectId: r.project_id,
          })
          // FIX (cron section 17, pass 4 — B4): the dedupe marker above is already written (weekly re-alert), so surface a lost bell.
          if (!noApproverNotified) run.rowError(`approval ${r.id}`, new Error('no-reachable-approver recorded but the admin bell notification failed to write'))
          escalated++
        }
        // 'not_found': already-resolved row race, or an orphan (current step missing). Counted in the
        // result so a persistent orphan is visible in cron_run_history instead of vanishing silently.
        else if (result === 'not_found') { notFound++; console.warn(`[cron:approval-stall] approval ${r.id}: reminder target not found (resolved mid-run, or orphaned)`) }
      } catch (e) { run.rowError(`approval ${r.id}`, e) }
    }
  })

  // Step 2 — approved documents that failed to auto-send and were never retried.
  await run.step('escalate stale send failures', async () => {
    const staleSendFailures = await fetchAll<any>('approval-stall send-failure select', (from, to) =>
      (service as any).from('approval_requests')
        .select('id, workspace_id, project_id, requested_by, document_type, send_failed_reason, updated_at, workspaces!inner(deleted_at)')
        .eq('status', 'approved')
        .not('send_failed_at', 'is', null)
        .lt('updated_at', cutoff)
        .is('workspaces.deleted_at', null)
        .order('id')
        .range(from, to))

    for (const r of staleSendFailures) {
      try {
        const sendFailNotified = await notifyMembersWithPermission(service, {
          workspaceId: r.workspace_id, permission: 'MANAGE_WORKSPACE_SETTINGS',
          eventType: 'approval_no_reachable_approver', type: 'approval_send_failed_stale',
          title: 'An approved document still hasn\u2019t been sent',
          body: `A ${documentLabelFor(r.document_type)} was approved ${threshold}+ days ago but couldn't be sent automatically (${r.send_failed_reason || 'send failed'}) and hasn't been retried.`,
          entityType: 'approval_request', entityId: r.id, projectId: r.project_id,
        })
        // FIX (cron section 17, pass 4 — B4): nothing has been recorded yet, so a failed write is simply retried next run
        // (the request is not bumped out of the window) rather than counted as "escalated".
        if (!sendFailNotified) throw new Error('admin bell notification failed to write — will retry next run')
        const { error: bumpErr } = await (service as any).from('approval_requests')
          .update({ updated_at: now.toISOString() }).eq('id', r.id)
        if (bumpErr) throw new Error(`send-failure bookkeeping failed (admins WERE notified): ${bumpErr.message}`)
        await insertAuditRow(service, {
          workspace_id: r.workspace_id, actor_id: null, project_id: r.project_id,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'approval.send_failure_escalated', entity_type: 'approval_request', entity_id: r.id,
          metadata: { days_stale: threshold },
        })
        sendFailureEscalated++
      } catch (e) { run.rowError(`send-failure ${r.id}`, e) }
    }
  })

  Object.assign(run.result, { reminded, escalated, sendFailureEscalated, healed, unresponsiveEscalated, notFound })
  const { body, status } = await run.finish()
  return NextResponse.json(body, { status })
}

// Vercel Cron invokes the configured path with GET; the GitHub Actions backup uses POST.
export const GET = POST
