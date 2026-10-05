export const runtime = 'nodejs'

import { isUuidString } from '@/lib/utils/uuid'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'
import { cleanTextField } from '@/lib/utils/sanitize'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkedSend } from '@/lib/email/delivery'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!hasPermission(session, 'SEND_SOW'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const cleanedReason = cleanTextField(body?.reason, 1000)
    if (cleanedReason === null)
      return NextResponse.json({ error: 'reason must be text' }, { status: 400 })
    const reason = cleanedReason || undefined

    const service = createServiceClient()
    // FIX (doc-completeness audit): added client/workspace so we can
    // notify the client that the link/SOW they may already have is dead.
    const { data: sow, error: sowReadErr } = await (service as any)
      .from('sow_documents')
      .select(`id,status,token,version,project_id,
        projects(id,name,status,client_id,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    // FIX (SOW lifecycle independent pass 15, B4): a failed read is not "not found" — fail into the route's 500 handler.
    if (sowReadErr) throw new Error(`SOW read failed: ${sowReadErr.message}`)

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const WITHDRAWABLE_FROM = ['awaiting_signature', 'changes_requested']
    if (!WITHDRAWABLE_FROM.includes(sow.status))
      return NextResponse.json({ error: 'SOW cannot be withdrawn in current status' }, { status: 400 })

    const now = new Date().toISOString()

    // FIX (re-audit, race-condition finding): this used to write
    // unconditionally on `.eq('id', id)` alone — a read-then-write gap,
    // unlike every actual signing-path transition in this lifecycle
    // (sign/decline/request-changes all CAS on the status they read).
    // Worst case: a withdraw racing a client's simultaneous Sign could let
    // the client's CAS-protected write land first (status -> 'signed',
    // fully executed with a real signature), then have this unconditional
    // write blindly flip it back to 'withdrawn' with the token nulled —
    // silently corrupting an already-completed legal document with no
    // error surfaced to anyone. Even without any client race, a plain
    // double-click of the Withdraw button duplicated the client-facing
    // cancellation email and the audit-log entry below, since nothing
    // stopped a second request from also matching. Guard the write the
    // same way every sibling transition already does: only the request
    // that actually wins the race continues past this point.
    const { data: withdrawn } = await (service as any).from('sow_documents')
      .update({ status: 'withdrawn', token: null, updated_at: now })
      .eq('id', id)
      .in('status', WITHDRAWABLE_FROM)
      .select('id')

    if (!withdrawn || withdrawn.length === 0)
      return NextResponse.json({ error: 'This SOW was already acted on by another action' }, { status: 409 })

    // Revoke token — after the CAS succeeds, so a losing double-click (or
    // a losing race against a client action) never revokes a token that's
    // still legitimately in play.
    if (sow.token) {
      // supabase-js returns errors rather than throwing, so this must read `error` itself.
      const { error: revokeErr } = await (service as any).from('revoked_tokens').insert({
        token: sow.token, token_type: 'sow', reason: 'withdrawn',
        revoked_by: session.id, document_id: id,
      })
      if (revokeErr) console.error('SOW withdraw: token revoke insert failed (non-fatal):', revokeErr.message)
    }

    // FIX (SOW lifecycle independent pass, B2): this reverted the project unconditionally, but the SOW
    // being withdrawn is not always the project's live one. A client's request-changes flips v1 to
    // 'changes_requested' and spawns v2; once v2 is sent the project is 'Awaiting Signature' on v2's account,
    // yet v1 keeps a Withdraw button in the version history (SOW-G1). Withdrawing v1 then dragged the project
    // back to Intake while v2 was still out for signature: sow-stall (which only watches
    // 'Awaiting Signature' projects) stopped tracking v2, dashboards showed the wrong stage, and only a
    // signature put it right. Only undo the project state when NO other version is out for signature.
    // (If the lookup itself fails, fall back to the previous behaviour rather than skip the revert.)
    const { data: otherLive, error: otherLiveErr } = await (service as any).from('sow_documents')
      .select('id').eq('project_id', sow.project_id).neq('id', id).eq('status', 'awaiting_signature').limit(1)
    if (otherLiveErr) console.error('SOW withdraw: could not check for another live SOW (reverting project anyway):', otherLiveErr.message)
    const anotherSowIsLive = !otherLiveErr && Array.isArray(otherLive) && otherLive.length > 0

    if (!anotherSowIsLive) {
      // Revert project to Intake
      // FIX (SOW lifecycle independent pass 13, B4): withdrawing a superseded 'changes_requested' version moved the project
      // from 'Changes Requested' back to 'Intake' even though the newer draft that carries the client's change request is
      // still open — the project then read as having no pending client feedback. 'Changes Requested' is only undone when
      // no draft is open. (If the lookup fails, the previous behaviour — revert — is kept.)
      const { data: openDraft, error: openDraftErr } = await (service as any).from('sow_documents')
        .select('id').eq('project_id', sow.project_id).neq('id', id).eq('status', 'draft').limit(1)
      if (openDraftErr) console.error('SOW withdraw: could not check for an open draft (reverting project anyway):', openDraftErr.message)
      const draftIsOpen = !openDraftErr && Array.isArray(openDraft) && openDraft.length > 0
      await (service as any).from('projects')
        .update({ status: 'Intake', updated_at: now })
        .eq('id', sow.projects?.id)
        .in('status', draftIsOpen ? ['Awaiting Signature'] : ['Awaiting Signature', 'Changes Requested'])
      // FIX (cron/portal audit round 3): sow-stall flips a project whose SOW sat unsigned for 7 days to
      // 'Stalled' / stall_reason 'sow_unsigned'. This revert only listed Awaiting Signature / Changes
      // Requested, so withdrawing a SOW that had gone stale — the most natural time to withdraw one — left the
      // project on 'Stalled' with a "SOW unsigned" reason and no SOW out at all. send, reopen, request-changes,
      // sign, decline and sow-expiry all reconcile that exact state; this was the odd one out. Same guard they
      // use: only undo the auto-stall THIS SOW caused; a project stalled for any other reason is left alone.
      await (service as any).from('projects')
        .update({ status: 'Intake', stall_reason: null, updated_at: now })
        .eq('id', sow.projects?.id)
        .eq('status', 'Stalled').eq('stall_reason', 'sow_unsigned')
    }

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'sow.withdrawn', entityType: 'sow',
      entityId: id, entityName: sow.projects?.name,
      metadata: { version: sow.version, ...(reason ? { reason } : {}) },
    })

    // FIX (doc-completeness audit): 'awaiting_signature' / 'changes_requested'
    // are only reachable after the SOW was actually sent to the client, so
    // if we got here they have a live link/email — tell them it's dead.
    const client = sow.projects?.clients
    let emailed = true
    // An unverified member never triggers outbound client email (same rule as sending and CO withdraw/close) — the
    // withdrawal itself still goes through, and the caller is told the client was not notified.
    if (client?.email && !session.emailVerifiedAt) emailed = false
    else if (client?.email) {
      const cc = await withPrimaryContactCc(service, sow.projects?.client_id, client.email, client.cc_emails, 'sow')
      const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
      const delivery = await checkedSend(() => sendDocumentCancelledEmail({
        replyTo,
        to: client.email, cc,
        clientName: client.name, agencyName: sow.projects?.workspaces?.agency_name,
        projectName: sow.projects?.name, documentLabel: 'Statement of Work',
        documentTitle: `${sow.projects?.name} — SOW v${sow.version}`,
        action: 'withdrawn', reason: reason || null,
        brandColour: sow.projects?.workspaces?.brand_colour,
        log: { workspaceId: session.workspaceId, kind: 'sow.withdraw_notice', entityType: 'sow', entityId: id, projectId: sow.project_id, actorId: session.id },
      }), 'SOW withdrawn email')
      emailed = delivery.ok
    }

    return NextResponse.json({ ok: true, clientNotified: emailed })
  } catch (err) {
    console.error('SOW withdraw error:', err)
    return NextResponse.json({ error: 'Could not withdraw this SOW. Please try again.' }, { status: 500 })
  }
}
