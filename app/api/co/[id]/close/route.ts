import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { cancelApprovalRequest } from '@/lib/approvals/engine'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'

// FIX (section-10 audit): this was documented and typed as a "shared
// handler for terminal non-accepted CO states: close, withdraw, decline"
// but nothing has ever called it with 'withdrawn' or 'declined' — the
// withdraw route (app/api/co/[id]/withdraw/route.ts) reimplements this
// logic independently, and there is no internal 'decline' action (only
// the client-facing portal route declines). The two implementations had
// already drifted: withdraw's TERMINAL_FROM allowed
// 'awaiting_countersignature' as a source status (added in migration 014
// doc-completeness fix) but this dead copy never got that update. Rather
// than leave an untested, silently-stale duplicate for a future dev to
// mistakenly wire up or "fix" in the wrong copy, narrowed this to what's
// actually used: 'closed' only. If withdraw/decline ever need to share
// logic with this again, extract a real shared helper both routes call,
// not a multi-status function only one status ever reaches.
async function handleTerminalCoState(
  id: string, newStatus: 'closed',
  session: any, service: any, body: any
) {
  // FIX (CO-logic fix round): expanded the select (client/workspace) so we
  // can notify the client below if this CO had already reached them —
  // same fields withdraw/route.ts already selects for the same reason.
  const { data: co } = await (service as any)
    .from('change_orders')
    .select(`id,title,status,flag_id,token,project_id,
      projects(id,name,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
    .eq('id', id).eq('workspace_id', session.workspaceId).single()

  if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })
  // FIX (audit round 3): see lib/utils/project-access.ts.
  if (!(await canReadProject(service, session, co.project_id)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const TERMINAL_FROM: Record<string, string[]> = {
    // FIX (doc-completeness audit, migration 014): 'awaiting_countersignature'
    // added alongside 'awaiting_response' for consistency — a CO stuck
    // waiting on either the client's initial response or their
    // countersignature should be closable the same way.
    closed: ['draft','awaiting_response','declined','countered','stalled','awaiting_countersignature'],
  }
  if (!TERMINAL_FROM[newStatus].includes(co.status))
    return NextResponse.json({ error: `Cannot ${newStatus} a CO with status ${co.status}` }, { status: 400 })

  // FIX (CO-logic fix round): a CO can be closed out of 'countered' —
  // the client made a counter-offer and is waiting on the agency's
  // response. Closing it here previously sent no notification at all,
  // unlike every other terminal transition in this lifecycle (withdraw
  // notifies the client; decline/accept are client-initiated). A client
  // who countered and then got silently closed out has no way to know
  // their offer was rejected rather than still pending. 'draft' never had
  // a client-facing state, so nothing to notify there.
  //
  // Deliberately NOT touching co.token/revoked_tokens the way withdraw
  // does: getCoByToken (api/portal/co/[token]/route.ts) already has a
  // dedicated, correctly-working 'closed' state for a client revisiting
  // their original link (see its own "BUG: 'closed', 'stalled', and
  // 'countered' were never included here" fix), which depends on the CO
  // still being resolvable by token so co.status can drive the response.
  // Nulling the token here would route that same revisit through the
  // revoked-token branch instead, which only special-cases 'withdrawn' and
  // would downgrade the client's page from the specific 'closed' state to
  // a generic 'revoked' one — trading a working, more informative path for
  // a token-hygiene win that isn't actually reachable by anyone else
  // (every mutating portal route already gates on co.status, same as the
  // SOW side's equivalent request-changes case).
  const wasSentToClient = co.status !== 'draft'

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { status: newStatus, updated_at: now, close_reason: body.reason || null }

  await (service as any).from('change_orders').update(updates).eq('id', id)

  // FIX (section-11 audit): a 'draft' CO can have a pending 'co' approval
  // request in flight (gated send), and a 'countered' CO can have a
  // pending 'co_counter' request (gated counter-acceptance) — see
  // lib/approvals/engine.ts. withdraw() already cancels these; this route
  // closed the CO out from under either one with no equivalent call,
  // leaving the approval request orphaned: still 'pending' forever, still
  // showing in the approver's queue, still getting reminded about by the
  // stall cron every 2 days, referencing a CO that no longer exists in
  // any open state. Both document_types share this CO's id, so both are
  // checked — cancelApprovalRequest itself is a no-op if neither has a
  // pending row.
  await cancelApprovalRequest(service, {
    documentType: 'co', documentId: id, workspaceId: session.workspaceId,
    actorId: session.id, actorEmail: session.email, actorName: session.name,
    reason: 'CO closed',
  })
  await cancelApprovalRequest(service, {
    documentType: 'co_counter', documentId: id, workspaceId: session.workspaceId,
    actorId: session.id, actorEmail: session.email, actorName: session.name,
    reason: 'CO closed',
  })

  // BUG-048, spec §6.2: flag reversion fires on decline, close, AND withdraw
  // (decline/withdraw handle their own reversion independently — see
  // app/api/co/[id]/withdraw/route.ts and app/api/portal/co/[token]/_actions.ts)
  // Does NOT fire on stalled or countered (not terminal)
  if (co.flag_id) {
    const { data: flag } = await (service as any)
      .from('guardian_flags').select('id,status').eq('id', co.flag_id).single()

    if (flag && flag.status === 'converted_to_co') {
      await (service as any).from('guardian_flags').update({
        status:          'open',
        change_order_id: null,
        updated_at:      now,
      }).eq('id', co.flag_id)

      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'flag.reverted_to_open', entityType: 'guardian_flag',
        entityId: co.flag_id, entityName: co.projects?.name,
        metadata: { co_id: id, co_status: newStatus, reason: 'CO reached terminal non-accepted state' },
      })
    }
  }

  await logAudit(service, {
    workspaceId: session.workspaceId, actorId: session.id,
    actorEmail: session.email, actorName: session.name,
    eventType: `co.${newStatus}`, entityType: 'change_order',
    entityId: id, entityName: co.title,
    metadata: { reason: body.reason, from_status: co.status },
  })

  const client = co.projects?.clients
  if (wasSentToClient && client?.email) {
    try {
      await sendDocumentCancelledEmail({
        to: client.email, cc: client.cc_emails || [],
        clientName: client.name, agencyName: co.projects?.workspaces?.agency_name,
        projectName: co.projects?.name, documentLabel: 'Change Order',
        documentTitle: co.title, action: 'closed', reason: body.reason || null,
        brandColour: co.projects?.workspaces?.brand_colour,
      })
    } catch (e) { console.error('CO closed client email failed:', e) }
  }

  return NextResponse.json({ ok: true })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // FIX (audit round 3): this route had no permission check at all — every
    // other CO-mutating action (send, remind, escalate, accept-counter,
    // create, PATCH) requires SEND_CHANGE_ORDERS or CREATE_CHANGE_ORDERS, but
    // close() only checked that a session existed. Any authenticated
    // workspace member, regardless of role, could close any CO in the
    // workspace and trigger the linked flag-reversion side effect.
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS' }, { status: 403 })
    const body    = await request.json().catch(() => ({}))
    const service = createServiceClient()
    return handleTerminalCoState(id, 'closed', session, service, body)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
