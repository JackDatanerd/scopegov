export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { sendSowExpiredEmail } from '@/lib/email/templates'

import { insertAuditRow } from '@/lib/utils/audit'
import { fetchAll, CronRun } from '@/lib/utils/cron-run'
// FIX (section-9 audit, 9-G3): 'expired' has been a valid sow_documents
// status since migration 001 — it's in the CHECK constraint, in the
// registry's pill-colour map (app/(app)/sow/page.tsx), and the client
// portal has a whole handler for `sow.status === 'expired'`. Nothing in
// the codebase ever wrote it.
//
// The practical effect: the signing JWT is issued with a 30-day expiry
// and the portal correctly rejects it afterwards, but the agency side
// never learned. An expired SOW sat at 'awaiting_signature' forever,
// kept counting toward the "Awaiting signature" figure on the SOW
// registry, and api/sow/[id]/remind would happily email the client a
// dead link. sow-stall only ever flipped the *project* to Stalled at 7
// days; it never touched the SOW itself and has nothing to say about
// the 30-day cliff.
//
// This closes the loop: flip genuinely expired SOWs to 'expired', tell
// the team, and leave them recoverable through the reopen route
// (app/api/sow/[id]/reopen) — which is exactly why 'expired' is in that
// route's REOPENABLE list.
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let service: any
  try {
    service = createServiceClient()
    // FIX (cron/portal audit round 3): this route (like co-expiry, invoice-expiry and guardian-flag-stall)
    // was never moved onto CronRun, so the round-2 promise — a failed query can't look like "nothing to
    // do" — didn't hold here. The row UPDATE below destructured only `data`: if it failed on every row
    // (a CHECK constraint that predates the 'expired' status, an RLS/permission change) `updated` was
    // null, the row was silently skipped, and a healthy heartbeat was recorded for a run that expired
    // nothing. Per-row failures are now reported through CronRun.rowError (alerting, heartbeat kept —
    // one poison row must not withhold it) and a failed SELECT fails the run outright.
    const run = new CronRun(service, 'sow-expiry')
    const now = new Date().toISOString()
    let expired = 0
    run.result.expired = 0

    await run.step('expire SOWs', async () => {
      // Only SOWs actually out with the client can expire. A draft has no token and no meaningful
      // expires_at; a signed/declined/withdrawn one has already reached a terminal state.
      const expiring = await fetchAll<any>('sow-expiry select', (from, to) =>
        (service as any)
          .from('sow_documents')
          .select('id, version, status, workspace_id, project_id, expires_at, token, projects(id, name, status, clients(name))')
          .in('status', ['awaiting_signature', 'changes_requested'])
          .not('expires_at', 'is', null)
          .lt('expires_at', now)
          .order('id')
          .range(from, to))

      for (const sow of expiring) {
        try {
          // CAS on the status we read — a client signing in the same instant must win over this sweep.
          const { data: updated, error: updErr } = await (service as any)
            .from('sow_documents')
            .update({ status: 'expired', token: null, updated_at: now })
            .eq('id', sow.id)
            .in('status', ['awaiting_signature', 'changes_requested'])
            .select('id, token')
          if (updErr) throw new Error(`expire update failed: ${updErr.message}`)
          if (!updated?.length) continue

          // decline and withdraw both insert a revoked_tokens row alongside nulling the document's own
          // token column, so the portal GET route can still resolve the right client-facing state after
          // the column goes null. Read the pre-update token from `sow` — that is what clients hold.
          if (sow.token) {
            const { error: revokeErr } = await (service as any).from('revoked_tokens').insert({
              token: sow.token, token_type: 'sow', reason: 'expired', document_id: sow.id,
            })
            // 23505: already revoked (a retry after a partial run) — the goal state, not a failure.
            if (revokeErr && (revokeErr as any).code !== '23505') run.rowError(`sow ${sow.id} token revoke`, revokeErr)
          }

          await insertAuditRow(service, {
            workspace_id: sow.workspace_id,
            actor_id:     null,
            actor_email:  'cron@scopegov.app',
            actor_name:   'ScopeGov',
            event_type:   'sow.expired',
            entity_type:  'sow',
            entity_id:    sow.id,
            entity_name:  sow.projects?.name,
            metadata:     { version: sow.version, expired_at: sow.expires_at },
          })

          // FIX (section-9 fix round): sign/decline/withdraw/request-changes/reopen all reconcile
          // projects.status/stall_reason when a SOW's story moves on — this cron was the one lifecycle
          // transition that never did. Left unfixed, a project the sow-stall cron had already flipped to
          // Stalled/'sow_unsigned' stayed stuck there forever once the SOW itself expired, and the
          // manual-resume check in app/api/projects/[id]/route.ts (`stall_reason === 'sow_unsigned'`) kept
          // telling the agency to "Resend the SOW... it resumes automatically" — impossible once expired,
          // since remind() requires a live token. Same fix shape as decline's: only undo the auto-stall this
          // exact SOW caused (Stalled + 'sow_unsigned'); a project stalled manually, or already moved on for
          // an unrelated reason, is left alone. A no-op for a 'changes_requested' expiry, whose project is
          // already at 'Changes Requested', not 'Stalled'.
          // (Round 3: the write's error is now read — a failure is a row error, not a silent skip.)
          const { error: projErr } = await (service as any).from('projects').update({
            status: 'Awaiting Signature', stall_reason: null, updated_at: now,
          }).eq('id', sow.project_id).eq('status', 'Stalled').eq('stall_reason', 'sow_unsigned')
          if (projErr) run.rowError(`sow ${sow.id} project status reconcile`, projErr)

          // A 'changes_requested' version was already answered by the client and superseded by a newer
          // draft — its link expiring is bookkeeping, not news. Announcing "signing link expired, start
          // a new version" for it told the team to redo work already in progress.
          if (sow.status === 'changes_requested') { expired++; continue }

          const projectName = sow.projects?.name || 'Untitled project'
          await notifyMembersWithPermission(service, {
            workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_expired',
            type: 'sow_expired', title: `SOW signing link expired — ${projectName}`,
            body: `The signing link for the ${projectName} SOW (v${sow.version}) has expired. Start a new version to send a fresh link.`,
            entityType: 'project', entityId: sow.project_id, projectId: sow.project_id,
          })

          // 'sow_expired' is an EVENT_TYPES entry (rendered under "Email notifications", lockable by
          // admins), so the toggle has to be backed by an actual email — see sendSowExpiredEmail.
          try {
            const emails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, 'sow_expired', sow.project_id)
            if (emails.length) {
              await sendSowExpiredEmail({
                to: emails,
                clientName: sow.projects?.clients?.name || 'Client',
                projectName,
                projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${sow.project_id}?tab=sow`,
              })
            }
          } catch (e) { run.rowError(`sow ${sow.id} expired email`, e) }

          expired++
        } catch (e) { run.rowError(`sow ${sow.id} expiry`, e) }
      }
      run.result.expired = expired
    })

    const { body, status } = await run.finish()
    return NextResponse.json(body, { status })
  } catch (err) {
    console.error('SOW expiry cron error:', err)
    await alertCronFailure(service ?? createServiceClient(), 'sow-expiry', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET — same aliasing as
// every other cron route here.
export const GET = POST
