export const runtime = 'nodejs'

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
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id,status,token,version,project_id,
        projects(id,name,status,client_id,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

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

    // Revert project to Intake
    await (service as any).from('projects')
      .update({ status: 'Intake', updated_at: now })
      .eq('id', sow.projects?.id)
      .in('status', ['Awaiting Signature','Changes Requested'])
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
    if (client?.email) {
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
      }), 'SOW withdrawn email')
      emailed = delivery.ok
    }

    return NextResponse.json({ ok: true, clientNotified: emailed })
  } catch (err) {
    console.error('SOW withdraw error:', err)
    return NextResponse.json({ error: 'Could not withdraw this SOW. Please try again.' }, { status: 500 })
  }
}
