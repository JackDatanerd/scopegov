export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { sendCoExpiredEmail } from '@/lib/email/templates'

import { insertAuditRow } from '@/lib/utils/audit'
import { fetchAll, CronRun } from '@/lib/utils/cron-run'
// FIX (section-10 audit, feature gap): mirrors app/api/cron/sow-expiry
// exactly — see that route's header comment for the full history of why
// this pattern exists. change_orders never had the equivalent: no
// 'expired' status (migration 044 adds it) and no cron. A CO's signing
// JWT still expires cryptographically at 30 days regardless of any of
// this (expires_at, checked defensively by api/co/[id]/remind), but the
// DB status just sat wherever co-stall last left it forever, with a
// dead, never-revoked token and zero proactive signal to the agency.
//
// Only a CO actually out with the client can expire — 'awaiting_response'
// (never got a response at all), 'awaiting_countersignature' (agency
// accepted their counter, client never came back to confirm it), and
// 'stalled' (co-stall's own 5-day mark, still carrying the same
// now-dead token and expires_at). 'countered' is deliberately excluded,
// same reasoning co-stall's own comment already gives for not
// auto-stalling it: a live counter-offer is an open negotiation the
// agency still needs to act on, not something a client's inaction can
// silently kill.
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let service: any
  try {
    service = createServiceClient()
    // FIX (cron/portal audit round 3): moved onto CronRun — see sow-expiry. The row UPDATE and the
    // revoked_tokens INSERT here both ignored their `error`, so a systematic failure looked like a
    // healthy run that expired nothing.
    const run = new CronRun(service, 'co-expiry')
    const now = new Date().toISOString()
    const EXPIRABLE_FROM = ['awaiting_response', 'awaiting_countersignature', 'stalled']
    let expired = 0
    run.result.expired = 0

    await run.step('expire change orders', async () => {
      const expiring = await fetchAll<any>('co-expiry select', (from, to) =>
        (service as any)
          .from('change_orders')
          .select('id, title, workspace_id, project_id, flag_id, expires_at, token, projects(id, name, clients(name))')
          .in('status', EXPIRABLE_FROM)
          .not('expires_at', 'is', null)
          .lt('expires_at', now)
          .order('id')
          .range(from, to))

      for (const co of expiring) {
        try {
          // CAS on the status we read — a client responding/countersigning in the same instant must
          // win over this sweep.
          const { data: updated, error: updErr } = await (service as any)
            .from('change_orders')
            .update({ status: 'expired', token: null, updated_at: now })
            .eq('id', co.id)
            .in('status', EXPIRABLE_FROM)
            .select('id')
          if (updErr) throw new Error(`expire update failed: ${updErr.message}`)
          if (!updated?.length) continue

          // Mirror decline/withdraw: a revoked_tokens row alongside nulling change_orders.token so the
          // portal can tell 'expired' from a generic dead link.
          if (co.token) {
            const { error: revokeErr } = await (service as any).from('revoked_tokens').insert({
              token: co.token, token_type: 'co', reason: 'expired', document_id: co.id,
            })
            if (revokeErr && (revokeErr as any).code !== '23505') run.rowError(`co ${co.id} token revoke`, revokeErr)
          }

          // FIX (cron/portal audit round 3): every other terminal, non-accepted path — client decline,
          // agency close, agency withdraw — releases the Guardian flag back to 'open' (spec §6.2, BUG-048)
          // and revise re-claims it. Expiry is just as terminal, but left the flag stranded in
          // 'converted_to_co' pointing at a dead CO: it dropped out of every "open flag" view and could
          // never be re-raised. Guarded on change_order_id so a flag already re-claimed by a newer
          // revision is never released out from under it.
          if (co.flag_id) {
            try {
              const { data: released, error: flagErr } = await (service as any).from('guardian_flags')
                .update({ status: 'open', change_order_id: null, updated_at: now })
                .eq('id', co.flag_id).eq('status', 'converted_to_co').eq('change_order_id', co.id)
                .select('id')
              if (flagErr) throw flagErr
              if (released?.length) {
                await insertAuditRow(service, {
                  workspace_id: co.workspace_id,
                  actor_id: null, actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
                  event_type: 'flag.reverted_to_open', entity_type: 'guardian_flag',
                  entity_id: co.flag_id, entity_name: co.projects?.name,
                  metadata: { co_id: co.id, co_status: 'expired', reason: 'CO reached terminal non-accepted state' },
                })
              }
            } catch (e) { run.rowError(`co ${co.id} flag release`, e) }
          }

          await insertAuditRow(service, {
            workspace_id: co.workspace_id,
            actor_id:     null,
            actor_email:  'cron@scopegov.app',
            actor_name:   'ScopeGov',
            event_type:   'co.expired',
            entity_type:  'change_order',
            entity_id:    co.id,
            entity_name:  co.title,
            metadata:     { expired_at: co.expires_at },
          })

          const projectName = co.projects?.name || 'Untitled project'
          await notifyMembersWithPermission(service, {
            workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_expired',
            type: 'co_expired', title: `Change order link expired — ${projectName}`,
            body: `The signing link for "${co.title}" on ${projectName} has expired. Revise and resend it to give the client a fresh link.`,
            entityType: 'project', entityId: co.project_id, projectId: co.project_id,
          })

          try {
            const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_expired', co.project_id)
            if (emails.length) {
              await sendCoExpiredEmail({
                to: emails,
                clientName: co.projects?.clients?.name || 'Client',
                projectName,
                projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
              })
            }
          } catch (e) { run.rowError(`co ${co.id} expired email`, e) }

          expired++
        } catch (e) { run.rowError(`co ${co.id} expiry`, e) }
      }
      run.result.expired = expired
    })

    const { body, status } = await run.finish()
    return NextResponse.json(body, { status })
  } catch (err) {
    console.error('CO expiry cron error:', err)
    await alertCronFailure(service ?? createServiceClient(), 'co-expiry', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET — same aliasing as
// every other cron route here.
export const GET = POST
