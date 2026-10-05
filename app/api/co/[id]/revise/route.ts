import { isUuidString } from '@/lib/utils/uuid'
import { createServiceClient } from '@/lib/supabase/server'
import { lookupMissResponse } from '@/lib/documents/co-lookup'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { isTerminalStatus } from '@/lib/utils/project-status'
import { approvalSendInFlight, SEND_IN_FLIGHT_MESSAGE } from '@/lib/approvals/engine'
import { cancelCoApprovals } from '@/lib/documents/co-approval-cancel'
import { insertNextCoVersion } from '@/lib/documents/co-version'
import { parseStoredLineItems } from '@/lib/documents/co-totals'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { resolveReplyTo } from '@/lib/email/reply-to'

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
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

    const service = createServiceClient()
    const { data: co, error: coLookupErr } = await (service as any)
      .from('change_orders')
      .select(`id, title, note, status, version, project_id, flag_id, root_co_id,
        projects(name, status, client_id, clients(name, email, cc_emails), workspaces(agency_name, brand_colour)),
        line_items, subtotal, tax_rate, tax_inclusive, total,
        counter_amount, counter_note, is_retainer_renewal, renewal_term_months, is_credit,
        timeline_impact_days, scope_impact_note`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return lookupMissResponse(coLookupErr, 'Change order not found')
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

    // FIX (CO logic independent pass, CO-2): revising a 'countered' CO is not just "make a new draft" - it CLOSES
    // the countered original, cancels its co_counter approval, reverts the linked flag and emails the client that
    // their offer was superseded. That is exactly what close/route.ts does, and close requires
    // SEND_CHANGE_ORDERS; this route only required CREATE_CHANGE_ORDERS, so a create-only member could close a
    // live negotiation and mail the client through the back door. Revising a dead CO (declined/withdrawn/closed/
    // expired) touches nothing client-facing, so CREATE_CHANGE_ORDERS stays enough there.
    if (co.status === 'countered' && !hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS (revising a countered change order closes it and notifies the client)' }, { status: 403 })

    // FIX (section-11 audit, pass 1 — B4): revising a 'countered' CO supersedes (closes) it and cancels its
    // co_counter approval — refuse while that request's final-approval auto-send is running right now.
    if (co.status === 'countered' && await approvalSendInFlight(service, session.workspaceId, ['co_counter'], co.id))
      return NextResponse.json({ error: SEND_IN_FLIGHT_MESSAGE }, { status: 409 })

    // line_items has been written both ways historically (see the
    // JSON.stringify note in app/api/co/route.ts) — handle both.
    // Only the newest version of a lineage can be revised, and never while another version is
    // live. Revising v1 twice, or revising a superseded v1 while v2 is out, produced sibling COs
    // that could BOTH be accepted (the same extra work billed twice).
    const rootId = co.root_co_id || co.id
    const { data: siblings, error: siblingsErr } = await (service as any)
      .from('change_orders').select('id, version, status')
      .or(`id.eq.${rootId},root_co_id.eq.${rootId}`).neq('id', co.id)
    // A failed read is not "no other versions": it skipped the newer-version and live-sibling guards below and let a
    // revision be created beside a live one. Surface it as the retryable error it is.
    if (siblingsErr) throw new Error(`could not read the other versions of this change order: ${siblingsErr.message}`)
    const others: any[] = siblings || []
    const openDraft = others.find(o => o.status === 'draft')
    // CO logic pass 7: an open draft next to a COUNTERED original is not a finished revision - revising a countered CO also
    // supersedes (closes) the original, and a crash or failed write between the draft insert and that supersede leaves exactly
    // this state. Handing the draft back alone left the original countered, so the draft could never be sent (the original
    // is a live sibling) and a countered CO cannot be withdrawn. Adopt the draft as THE revision and finish the supersede
    // below. For any other status the original is already dead and the draft is simply returned.
    if (openDraft && co.status !== 'countered')
      return NextResponse.json({ coId: openDraft.id, version: openDraft.version, existing: true })
    const adopted = !!openDraft
    let revision: { id: string; version: number }
    let clientNotified = true
    if (openDraft) {
      revision = { id: openDraft.id, version: openDraft.version }
    } else {
      const newer = others.find(o => o.version > co.version)
      if (newer)
        return NextResponse.json({ error: `A newer version (v${newer.version}) of this change order exists — revise that one instead.` }, { status: 409 })
      const live = others.find(o => ['awaiting_response', 'stalled', 'awaiting_countersignature', 'accepted'].includes(o.status))
      if (live)
        return NextResponse.json({ error: `Version ${live.version} of this change order is ${String(live.status).replace(/_/g, ' ')}.` }, { status: 409 })

      const lineItems = parseStoredLineItems(co.line_items)

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
        is_credit:            !!co.is_credit,
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
      revision = { id: result.id!, version: result.version! }

      // CO-3: the open-draft check above and the insert are separate statements, so two concurrent revises (two tabs, a
      // double click) both passed it and left two sibling drafts (v2 and v3). insertNextCoVersion already gives them
      // distinct versions; settle the tie deterministically here — the LOWEST-versioned open draft wins and any later one
      // withdraws itself and hands back the winner, exactly like the early "existing" return. A draft sibling that lost
      // the race is deleted before it can be sent, so it never becomes a second live version of the same change.
      const { data: earlierDrafts } = await (service as any)
        .from('change_orders').select('id, version')
        .or(`id.eq.${rootId},root_co_id.eq.${rootId}`)
        .eq('status', 'draft').neq('id', revision.id).lt('version', revision.version)
        .order('version', { ascending: true }).limit(1)
      if (earlierDrafts && earlierDrafts.length > 0) {
        await (service as any).from('co_attachments').delete().eq('co_id', revision.id)
        const { error: dropErr } = await (service as any).from('change_orders').delete().eq('id', revision.id).eq('status', 'draft')
        if (dropErr) console.error('CO revise: could not drop duplicate draft', dropErr.message)
        else return NextResponse.json({ coId: earlierDrafts[0].id, version: earlierDrafts[0].version, existing: true })
      }

    }

    // A 'countered' CO is still live from the client's point of view —
    // superseding it with a revision means closing out the old one so it
    // stops showing as an open negotiation (and so its linked Guardian
    // flag reverts through the normal close path rather than being left
    // pointing at an abandoned CO).
    if (co.status === 'countered') {
      // The revision draft above was inserted BEFORE the supersede below, so every early exit from here on must remove
      // it again (it can never be sent while the original is live, and the caller must not be told it succeeded).
      // An ADOPTED draft pre-dates this request (the user may have edited it), so it is never deleted - only a draft this
      // request created itself is.
      const dropOrphanRevision = async () => {
        if (adopted) return
        await (service as any).from('co_attachments').delete().eq('co_id', revision.id)
        const { error: orphanErr } = await (service as any).from('change_orders').delete().eq('id', revision.id).eq('status', 'draft')
        if (orphanErr) console.error('CO revise: could not remove the orphaned revision draft', orphanErr.message)
      }

      // FIX (CO logic, independent pass 6): a gated counter-acceptance leaves a pending 'co_counter' approval request
      // while this CO stays 'countered'. It used to be cancelled AFTER the supersede write with `blockedBySend`
      // ignored: the last approver clearing the final step after the approvalSendInFlight check near the top of this
      // handler stamped the send claim, the cancel was refused, the original was closed anyway, and the auto
      // counter-acceptance then failed against a closed CO — a false "Approved — not sent" that can never be retried.
      // Cancel FIRST, and when a send is live back out (drop the draft, leave the original countered).
      // cancelCoApprovals THROWS on a failed approval lookup/cancel write. The draft is already inserted, so remove it before
      // surfacing the error: the route's catch-all used to 500 and leave a stray draft beside a still-countered original.
      let cancelled: Awaited<ReturnType<typeof cancelCoApprovals>>
      try {
        cancelled = await cancelCoApprovals(service, {
          workspaceId: session.workspaceId, coId: co.id,
          actorId: session.id, actorEmail: session.email, actorName: session.name,
          reason: `Superseded by revision v${revision.version}`, types: ['co_counter'],
        })
      } catch (cancelErr) {
        await dropOrphanRevision()
        throw cancelErr
      }
      if (cancelled.blockedBySend) {
        await dropOrphanRevision()
        return NextResponse.json({ error: SEND_IN_FLIGHT_MESSAGE }, { status: 409 })
      }

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
      const { data: superseded, error: supersedeErr } = await (service as any).from('change_orders')
        .update({
          status: 'closed',
          close_reason: `Superseded by revision v${revision.version}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', co.id).eq('status', 'countered')
        .select('id').maybeSingle()
      // A failed write is not a lost race: reporting it as "just acted on by someone else" sent the user hunting for a
      // conflict that did not exist. Back the draft out and surface it as the retryable error it is.
      if (supersedeErr) {
        await dropOrphanRevision()
        throw new Error(`could not supersede the countered change order: ${supersedeErr.message}`)
      }

      if (superseded) {
        // FIX (deep audit, CO logic re-pass round 4 — flagship finding):
        // the comment on the flag re-claim below this block ("released
        // back to 'open' when the earlier version was declined/withdrawn/
        // closed") is true for every OTHER member of REVISABLE — but
        // 'countered' is closed out right here, inline, by this very
        // block, and this block only ever touched change_orders, never
        // guardian_flags. Every other path that closes a CO
        // (close/route.ts, withdraw/route.ts, the portal's decline
        // action, cron/co-expiry) reverts the linked flag to 'open' as
        // part of closing it — this was the one exception. Left
        // unfixed, the re-claim below (`.eq('status', 'open')`) silently
        // matched zero rows for a superseded 'countered' CO: the flag
        // stayed stuck at 'converted_to_co' pointing at the now-closed
        // original CO forever, and the new revision — the CO actually
        // live now — never got linked to it at all. Revert it here, same
        // shape as close()'s own reversion, so the generic re-claim below
        // picks it up like it does for every other status.
        if (co.flag_id) {
          const { data: flag } = await (service as any)
            .from('guardian_flags').select('id,status').eq('id', co.flag_id).single()
          if (flag && flag.status === 'converted_to_co') {
            await (service as any).from('guardian_flags').update({
              status: 'open', change_order_id: null, updated_at: new Date().toISOString(),
            }).eq('id', co.flag_id).eq('status', 'converted_to_co')
              // Only revert a flag still linked to THIS CO (or to nothing) — status alone never
              // proved ownership (deep audit, CO logic independent re-pass).
              .or(`change_order_id.eq.${co.id},change_order_id.is.null`)
            await logAudit(service, {
              workspaceId: session.workspaceId, actorId: session.id,
              actorEmail: session.email, actorName: session.name,
              eventType: 'flag.reverted_to_open', entityType: 'guardian_flag',
              entityId: co.flag_id, entityName: co.projects?.name,
              metadata: { co_id: co.id, co_status: 'closed', reason: `Superseded by revision v${revision.version}` },
            })
          }
        }

        // FIX (independent pass round 2, traced from section 14 via client-contacts): a
        // 'countered' CO is one the client has actually seen and responded to — every other
        // route that closes out a CO the client has seen (close, withdraw) emails them so they
        // aren't left staring at a stale link. This route imported sendDocumentCancelledEmail,
        // checkedSend and withPrimaryContactCc for exactly that but never called them, so a
        // client whose counter-offer got superseded by a revision was never told the old CO was
        // closed — they'd just see the same link go dead with no explanation until a new one
        // arrived (if it ever did).
        const client = co.projects?.clients
        // CO-2: an unverified member never triggers outbound client email (same rule as send/close/withdraw) - the
        // supersede itself still goes through and the UI is told the client was not notified.
        if (client?.email && !session.emailVerifiedAt) clientNotified = false
        else if (client?.email) {
          const cc = await withPrimaryContactCc(service, co.projects?.client_id, client.email, client.cc_emails, 'co')
          const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
          const delivery = await checkedSend(() => sendDocumentCancelledEmail({
            replyTo,
            to: client.email, cc,
            clientName: client.name, agencyName: co.projects?.workspaces?.agency_name,
            projectName: co.projects?.name, documentLabel: 'Change Order',
            documentTitle: co.title, action: 'closed',
            reason: `Superseded by revision v${revision.version}`,
            brandColour: co.projects?.workspaces?.brand_colour,
            log: { workspaceId: session.workspaceId, kind: 'co.revise_notice', entityType: 'change_order', entityId: co.id, projectId: co.project_id, actorId: session.id },
          }), 'CO superseded-by-revision (client) email')
          clientNotified = delivery.ok
        }
      } else {
        // The CO was no longer 'countered' by the time we got here (a
        // concurrent accept-counter or close already moved it on) — the
        // new revision draft is still perfectly valid, but we must NOT
        // claim the original was "superseded" (it wasn't) or cancel an
        // approval request on that false premise (accept-counter's own
        // flow already resolved it correctly on its own).
        console.warn('CO revise: supersede lost a race, co.id =', co.id, '— original CO had already moved on from countered')
        // CO-B2: the revision draft was inserted BEFORE this compare-and-swap. If accept-counter won, the original is
        // now awaiting_countersignature (live), so the draft can never be sent (send-co refuses while a sibling is live)
        // and the caller was told the revision succeeded and the client was notified. Remove the orphan and say so.
        // (An adopted draft pre-dates this request and is kept - see dropOrphanRevision.)
        if (!adopted) {
          await (service as any).from('co_attachments').delete().eq('co_id', revision.id)
          const { error: orphanErr } = await (service as any).from('change_orders').delete().eq('id', revision.id).eq('status', 'draft')
          if (orphanErr) console.error('CO revise: could not remove the orphaned revision draft', orphanErr.message)
        }
        return NextResponse.json(
          { error: 'This counter-offer was just acted on by someone else — refresh to see where it stands.' },
          { status: 409 }
        )
      }
    }

    // The flag was released back to 'open' when the earlier version was declined/withdrawn/closed/expired,
    // or (for 'countered') by the supersede block just above; re-claim it for this revision, otherwise the
    // same flag can be converted into a second CO.
    if (co.flag_id) {
      // The write's error used to be ignored: a transient failure left the flag 'open' and unlinked while the revision
      // carried its id, so a second change order could still be drafted from the same flag. Retry once, then say so loudly
      // (zero matched rows with no error just means the flag is not ours to claim - already linked or resolved).
      let claimErr: any = null
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await (service as any).from('guardian_flags')
          .update({ status: 'converted_to_co', change_order_id: revision.id, updated_at: new Date().toISOString() })
          .eq('id', co.flag_id).eq('status', 'open').is('change_order_id', null)
          .select('id')
        claimErr = r.error
        if (!claimErr) break
      }
      if (claimErr) console.error('CO revise: could not re-claim the linked flag:', co.flag_id, revision.id, claimErr.message)
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

    return NextResponse.json({ coId: revision.id, version: revision.version, clientNotified })
  } catch (err) {
    console.error('CO revise error:', err)
    return NextResponse.json({ error: 'Could not create a revision. Please try again.' }, { status: 500 })
  }
}
