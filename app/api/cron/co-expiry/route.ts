export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { sendCoExpiredEmail } from '@/lib/email/templates'

import { insertAuditRow } from '@/lib/utils/audit'
import { fetchAll } from '@/lib/utils/cron-run'
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

  try {
    const service = createServiceClient()
    const now     = new Date().toISOString()
    const EXPIRABLE_FROM = ['awaiting_response', 'awaiting_countersignature', 'stalled']

    // FIX (cron audit, section 17 re-pass): unpaginated — past 1000 change
    // orders simultaneously past their expiry (PostgREST's max_rows), the
    // tail silently never expired. Same bug class reconciliation-rollup and
    // scope-health-rollup were fixed for; paged here the same way.
    const expiring = await fetchAll<any>('co-expiry select', (from, to) =>
      (service as any)
        .from('change_orders')
        .select('id, title, workspace_id, project_id, expires_at, token, projects(id, name, clients(name))')
        .in('status', EXPIRABLE_FROM)
        .not('expires_at', 'is', null)
        .lt('expires_at', now)
        .order('id')
        .range(from, to))

    let expired = 0
    for (const co of expiring) {
      try {
        // CAS on the status we read — a client responding/countersigning
        // in the same instant must win over this sweep.
        const { data: updated } = await (service as any)
          .from('change_orders')
          .update({ status: 'expired', token: null, updated_at: now })
          .eq('id', co.id)
          .in('status', EXPIRABLE_FROM)
          .select('id')

        if (!updated?.length) continue

        // FIX (build, cron/portal audit round — see migration 051 and the
        // identical fix in sow-expiry): insert a revoked_tokens row
        // alongside nulling change_orders.token, mirroring exactly how
        // decline/withdraw already do it, so the portal GET route's
        // revoked-reason handling can distinguish 'expired' from a
        // generic dead link instead of both collapsing to the same
        // fallback state once the token column is gone.
        await (service as any).from('revoked_tokens').insert({
          token: co.token, token_type: 'co', reason: 'expired', document_id: co.id,
        })

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
        } catch (e) { console.error('CO expired email failed:', e) }

        expired++
      } catch (e) { console.error('CO expiry error:', e) }
    }

    await recordCronHeartbeat(service, 'co-expiry', { expired })
    return NextResponse.json({ ok: true, expired })
  } catch (err) {
    console.error('CO expiry cron error:', err)
    await alertCronFailure(createServiceClient(), 'co-expiry', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET — same aliasing as
// every other cron route here.
export const GET = POST
