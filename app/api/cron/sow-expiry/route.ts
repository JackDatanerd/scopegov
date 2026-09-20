export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { sendSowExpiredEmail } from '@/lib/email/templates'

import { insertAuditRow } from '@/lib/utils/audit'
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

  try {
    const service = createServiceClient()
    const now     = new Date().toISOString()

    // Only SOWs actually out with the client can expire. A draft has no
    // token and no meaningful expires_at; a signed/declined/withdrawn one
    // has already reached a terminal state.
    const { data: expiring, error: expiringErr } = await (service as any)
      .from('sow_documents')
      .select('id, version, status, workspace_id, project_id, expires_at, token, projects(id, name, status, clients(name))')
      .in('status', ['awaiting_signature', 'changes_requested'])
      .not('expires_at', 'is', null)
      .lt('expires_at', now)
    if (expiringErr) throw new Error(`sow-expiry select: ${expiringErr.message}`) // was silently treated as "nothing to expire"

    let expired = 0
    for (const sow of (expiring || [])) {
      try {
        // CAS on the status we read — a client signing in the same
        // instant must win over this sweep.
        const { data: updated } = await (service as any)
          .from('sow_documents')
          .update({ status: 'expired', token: null, updated_at: now })
          .eq('id', sow.id)
          .in('status', ['awaiting_signature', 'changes_requested'])
          .select('id, token')

        if (!updated?.length) continue

        // FIX (build, cron/portal audit round — see migration 051): decline
        // and withdraw both insert a revoked_tokens row alongside nulling
        // the document's own token column, so the portal GET route can
        // still resolve the right client-facing state even after the
        // column goes null. This route only ever did the null — closing
        // that gap here, mirroring decline's own revoked_tokens insert
        // exactly, just with reason: 'expired'. Read the pre-update token
        // from `sow` (the row fetched above, before this UPDATE nulled it)
        // since that's the value clients actually have in hand.
        // supabase-js returns errors rather than throwing; read it so a failed revoke is visible.
        if (sow.token) {
          const { error: revokeErr } = await (service as any).from('revoked_tokens').insert({
            token: sow.token, token_type: 'sow', reason: 'expired', document_id: sow.id,
          })
          if (revokeErr) console.error('SOW expiry: token revoke insert failed:', revokeErr.message)
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

        // A 'changes_requested' version was already answered by the client and superseded by a
        // newer draft — its link expiring is bookkeeping, not news. Announcing "signing link
        // expired, start a new version" for it told the team to redo work already in progress.
        if (sow.status === 'changes_requested') { expired++; continue }

        const projectName = sow.projects?.name || 'Untitled project'
        await notifyMembersWithPermission(service, {
          workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_expired',
          type: 'sow_expired', title: `SOW signing link expired — ${projectName}`,
          body: `The signing link for the ${projectName} SOW (v${sow.version}) has expired. Start a new version to send a fresh link.`,
          entityType: 'project', entityId: sow.project_id, projectId: sow.project_id,
        })

        // FIX (deep audit, notifications section): 'sow_expired' has been
        // an EVENT_TYPES entry (rendered under "Email notifications,"
        // lockable by admins) since 9-G3, but no email ever backed the
        // toggle — only the in-app row above ever fired. See
        // sendSowExpiredEmail.
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
        } catch (e) { console.error('SOW expired email failed:', e) }

        expired++
      } catch (e) { console.error('SOW expiry error:', e) }
    }

    await recordCronHeartbeat(service, 'sow-expiry', { expired })
    return NextResponse.json({ ok: true, expired })
  } catch (err) {
    console.error('SOW expiry cron error:', err)
    await alertCronFailure(createServiceClient(), 'sow-expiry', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET — same aliasing as
// every other cron route here.
export const GET = POST
