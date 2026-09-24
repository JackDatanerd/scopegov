import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { isTerminalStatus } from '@/lib/utils/project-status'
import { cancelApprovalRequest } from '@/lib/approvals/engine'
import { insertNextCoVersion } from '@/lib/documents/co-version'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'

// FIX (section-10 audit, 10-G2 + 10-G3 + 10-G4):
//
// The CO negotiation loop had no way back from any non-accepted outcome.
//   - 10-G2: from 'countered' the only moves were Accept or Close. There
//     was no way to respond at a third number without destroying the CO
//     and rebuilding it from scratch, losing the line items, the Guardian
//     flag link, and the audit thread.
//   - 10-G3: CoCard rendered a "Negotiate" button on a declined CO that
//     linked to CoEditor — which sets isLocked = status !== 'draft', so
//     it opened read-only under a banner saying "Withdraw it to edit",
//     and withdraw isn't even permitted from 'declined'. The one labelled
//     recovery path from a client decline was a dead button.
//   - 10-G4: a withdrawn CO was equally terminal, under the same banner,
//     which made withdrawing strictly worse than doing nothing.
//
// Same shape as the SOW reopen route and the portal's own
// request-changes flow: clone forward into a new draft, leave the
// original intact and auditable as the thing the client actually saw.
// parent_co_id (which has existed on change_orders since migration 001
// and was never used) records the lineage.
//
// FIX (section-10 audit, feature gap — CO expiry): 'expired' added
// alongside the four above. Migration 044 + cron/co-expiry give a CO the
// same 'expired' terminal state SOW has had since early on — same
// recovery path SOW's own reopen route already offers for it.
const REVISABLE = ['declined', 'withdrawn', 'closed', 'countered', 'expired']

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select(`id, title, note, status, version, project_id, flag_id, root_co_id,
        projects(name, status, client_id, clients(name, email, cc_emails), workspaces(agency_name, brand_colour)),
        line_items, subtotal, tax_rate, tax_inclusive, total,
        counter_amount, counter_note, is_retainer_renewal, renewal_term_months,
        timeline_impact_days, scope_impact_note`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Change order not found' }, { status: 404 })
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // FIX (CO-logic fix round): same gap as generate/reopen already had on the
    // SOW side — send-co.ts refuses to send a CO to a Complete/Archived
    // project, but revise (which also just creates a fresh draft) never
    // checked, unlike its two sibling creation routes (POST /api/co and
    // POST /api/co/draft, both of which already guard this). A declined/
    // withdrawn/closed/countered/expired CO on a project closed out in the
    // meantime could still be "revised" into a new draft that could then
    // never be sent, with no explanation until the send attempt itself.
    if (isTerminalStatus(co.projects?.status)) {
      return NextResponse.json({
        error: `This project is ${String(co.projects.status).toLowerCase()} — a change order can no longer be revised. Reopen the project first.`,
      }, { status: 409 })
    }

    if (!REVISABLE.includes(co.status))
      return NextResponse.json(
        { error: `A ${co.status.replace(/_/g, ' ')} change order can't be revised.` },
        { status: 400 }
      )

    // line_items has been written both ways historically (see the
    // JSON.stringify note in app/api/co/route.ts) — handle both.
    // Only the newest version of a lineage can be revised, and never while another version is
    // live. Revising v1 twice, or revising a superseded v1 while v2 is out, produced sibling COs
    // that could BOTH be accepted (the same extra work billed twice).
    const rootId = co.root_co_id || co.id
    const { data: siblings } = await (service as any)
      .from('change_orders').select('id, version, status')
      .or(`id.eq.${rootId},root_co_id.eq.${rootId}`).neq('id', co.id)
    const others: any[] = siblings || []
    const openDraft = others.find(o => o.status === 'draft')
    if (openDraft) return NextResponse.json({ coId: openDraft.id, version: openDraft.version, existing: true })
    const newer = others.find(o => o.version > co.version)
    if (newer)
      return NextResponse.json({ error: `A newer version (v${newer.version}) of this change order exists — revise that one instead.` }, { status: 409 })
    const live = others.find(o => ['awaiting_response', 'stalled', 'awaiting_countersignature', 'accepted'].includes(o.status))
    if (live)
      return NextResponse.json({ error: `Version ${live.version} of this change order is ${String(live.status).replace(/_/g, ' ')}.` }, { status: 409 })

    const lineItems = typeof co.line_items === 'string'
      ? JSON.parse(co.line_items)
      : (co.line_items || [])

    // FIX (section-10 re-pass): this used to read `MAX(version) WHERE
    // project_id = X` — project-wide, unguarded, and the wrong scope. A
    // project can have several independent CO lineages living side by
    // side (every new top-level CO starts at v1 via the column default),
    // so a project-wide max both races under concurrent revises AND can
    // jump this CO's version number to whatever an unrelated CO in the
    // same project happens to be at. insertNextCoVersion scopes the
    // query and the uniqueness constraint (migration 037) to this CO's
    // own lineage, and retries on a version collision instead of racing.
    const rootCoId = rootId
    const result = await insertNextCoVersion(service, rootCoId, {
      project_id:   co.project_id,
      workspace_id: session.workspaceId,
      parent_co_id: co.id,
      status:       'draft',
      title:        co.title,
      note:         co.note,
      flag_id:      co.flag_id,
      line_items:   lineItems,
      subtotal:     co.subtotal,
      tax_rate:     co.tax_rate,
      tax_inclusive: co.tax_inclusive,
      total:        co.total,
      is_retainer_renewal:  co.is_retainer_renewal,
      renewal_term_months:  co.renewal_term_months,
      timeline_impact_days: co.timeline_impact_days,
      scope_impact_note:    co.scope_impact_note,
      created_by:   session.id,
      // Deliberately NOT copied: token, sent_at, expires_at,
      // document_number, counter/accept/decline/close fields. The
      // revision has to earn all of those through a real send.
    })

    if (!result.ok) {
      console.error('CO revise: insert failed', result.error)
      return NextResponse.json({ error: 'Could not create a revision' }, { status: 500 })
    }
    const revision = { id: result.id!, version: result.version! }

    // A 'countered' CO is still live from the client's point of view —
    // superseding it with a revision means closing out the old one so it
    // stops showing as an open negotiation (and so its linked Guardian
    // flag reverts through the normal close path rather than being left
    // pointing at an abandoned CO).
    if (co.status === 'countered') {
      // FIX (section-11 fix round, real bug): this write had no
      // compare-and-swap verification — every other status transition in
      // this file (and its siblings, close/withdraw/accept-counter) checks
      // whether its own guarded update actually matched a row before
      // proceeding. This one didn't: if accept-counter or close/route.ts
      // won a race against this same CO in the gap between the read above
      // and this write, the update below would silently affect zero rows,
      // but the code carried on as if it had succeeded — logging an audit
      // entry claiming "Superseded by revision vN" and cancelling the
      // co_counter approval request with that same false reason, even
      // though the original CO had actually moved on to something else
      // (accepted, or already closed for a different reason). Capture the
      // result and only treat the supersede as real if a row actually
      // matched.
      const { data: superseded } = await (service as any).from('change_orders')
        .update({
          status: 'closed',
          close_reason: `Superseded by revision v${revision.version}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', co.id).eq('status', 'countered')
        .select('id').maybeSingle()

      if (superseded) {
        // FIX (section-11 audit): accepting a counter-offer on a gated
        // workflow creates a pending 'co_counter' approval request while
        // this CO stays 'countered' (see accept-counter/route.ts +
        // lib/approvals/engine.ts) — superseding it here with a revision,
        // same gap as close/route.ts, left that request orphaned: still
        // pending, still in the approver's queue, referencing a CO that's
        // now closed. Cancel it the same way withdraw() and close() do.
        await cancelApprovalRequest(service, {
          documentType: 'co_counter', documentId: co.id, workspaceId: session.workspaceId,
          actorId: session.id, actorEmail: session.email, actorName: session.name,
          reason: `Superseded by revision v${revision.version}`,
        })
      } else {
        // The CO was no longer 'countered' by the time we got here (a
        // concurrent accept-counter or close already moved it on) — the
        // new revision draft is still perfectly valid, but we must NOT
        // claim the original was "superseded" (it wasn't) or cancel an
        // approval request on that false premise (accept-counter's own
        // flow already resolved it correctly on its own).
        console.warn('CO revise: supersede lost a race, co.id =', co.id, '— original CO had already moved on from countered')
      }
    }

    // The flag was released back to 'open' when the earlier version was declined/withdrawn/closed;
    // re-claim it for this revision, otherwise the same flag can be converted into a second CO.
    if (co.flag_id) {
      await (service as any).from('guardian_flags')
        .update({ status: 'converted_to_co', change_order_id: revision.id, updated_at: new Date().toISOString() })
        .eq('id', co.flag_id).eq('status', 'open')
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.revised', entityType: 'change_order',
      entityId: revision.id, entityName: co.title,
      metadata: {
        from_co_id: co.id, from_status: co.status,
        from_version: co.version, new_version: revision.version,
        ...(co.counter_amount != null ? { client_counter_amount: co.counter_amount } : {}),
      },
    })

    return NextResponse.json({ coId: revision.id, version: revision.version })
  } catch (err) {
    console.error('CO revise error:', err)
    return NextResponse.json({ error: 'Could not create a revision. Please try again.' }, { status: 500 })
  }
}
