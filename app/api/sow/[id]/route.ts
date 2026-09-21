import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sanitizeRichText, cleanTextField } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
// NOTE: helpers live in lib/sow/sections.ts, not here — a Next.js route
// module may only export route handlers, so exporting them from this file
// failed the production build ("hydrateSections is not a valid Route
// export field") even though `tsc --noEmit` was perfectly happy.
import { REQUIRED_SECTION_IDS, hydrateSections, sanitizeSectionList, sanitizeTableRows, MAX_SECTION_CONTENT_LENGTH, MAX_TABLE_CELL_LENGTH, MAX_TABLE_ROWS } from '@/lib/sow/sections'
import { isTableSection } from '@/lib/sow/table-schema'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id, status, sent_at, sections, metadata, project_id')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts — GET/PATCH
    // here only checked workspace_id, letting a VIEW_OWN_PROJECTS-only
    // member with EDIT_SOW read or edit SOW documents for projects they
    // aren't assigned to.
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Lock check — sentAt makes document permanently read-only (spec §0.6)
    // FIX (section-9 audit, 9-G2): the old message read "Withdraw to
    // edit." — but withdraw only sets status, it never clears sent_at, so
    // withdrawing landed the user right back on this identical 409. The
    // instruction was circular and there was no working escape at all.
    // There is now: POST /api/sow/[id]/reopen clones a withdrawn/declined/
    // expired SOW forward into a fresh editable draft. Point at that.
    if (sow.sent_at)
      return NextResponse.json({
        error: sow.status === 'draft'
          ? 'This SOW has already been sent and can no longer be edited.'
          : 'This SOW has already been sent. Start a new version to make changes.',
      }, { status: 409 })

    // FIX (re-audit, critical finding): a SOW gated by an approval workflow
    // never leaves status:'draft' until the chain clears — the gate
    // intercepts BEFORE sendSowDocument ever runs — so this route's only
    // lock condition (sent_at) never applied to a gated draft. Approvers
    // were reviewing a snapshot of title/amount, but nothing stopped the
    // actual document from being edited out from under that snapshot
    // before the final approval fired the real send. Block edits while a
    // decision is outstanding — the requester can cancel it (which reopens
    // editing) if they need to change something first.
    if (await getPendingApprovalForDocument(service, 'sow', id)) {
      return NextResponse.json(
        { error: 'This SOW has a pending approval request — cancel it before editing.' },
        { status: 409 }
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object')
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    const LOCKED_MSG = 'This SOW has already been sent and can no longer be edited.'

    // Every write below is guarded on "still an unsent draft". The checks above are only
    // a fast path: without the guard on the write itself, a send that landed between the
    // read and the update let edits slip into a document already in front of the client.
    const guardedUpdate = async (patch: Record<string, unknown>) => {
      const { data: written, error } = await (service as any)
        .from('sow_documents')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).eq('status', 'draft').is('sent_at', null)
        .select('id')
      if (error) throw new Error(error.message)
      return Array.isArray(written) && written.length > 0
    }

    // The MSA reference is plain text rendered on the PDF masthead — independent of sections.
    if (body.msaReference !== undefined) {
      const cleaned = cleanTextField(body.msaReference, 200)
      if (cleaned === null)
        return NextResponse.json({ error: 'msaReference must be text' }, { status: 400 })
      const ok = await guardedUpdate({ metadata: { ...(sow.metadata || {}), msaReference: cleaned || null } })
      if (!ok) return NextResponse.json({ error: LOCKED_MSG }, { status: 409 })
      return NextResponse.json({ ok: true })
    }

    // Section content is rendered raw via dangerouslySetInnerHTML on the public portal
    // page — sanitize here (this route bypasses the TipTap editor's own constraints).
    const hydrated = hydrateSections(sow.sections || [], sow.metadata)

    // Whole-list replace (kept for API callers): server owns id/title/order, the client
    // only supplies content / visible / table.
    if (body.sections !== undefined) {
      if (!Array.isArray(body.sections))
        return NextResponse.json({ error: 'sections must be a list' }, { status: 400 })
      const ok = await guardedUpdate({ sections: sanitizeSectionList(body.sections, sow.sections || [], sow.metadata) })
      if (!ok) return NextResponse.json({ error: LOCKED_MSG }, { status: 409 })
      return NextResponse.json({ ok: true })
    }

    // Everything else edits exactly ONE section.
    if (typeof body.sectionId !== 'string')
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    const target = hydrated.find((s: any) => s.id === body.sectionId)
    if (!target)
      return NextResponse.json({ error: 'Unknown section' }, { status: 400 })

    let patch: Record<string, unknown>
    if (body.table !== undefined) {
      if (!isTableSection(body.sectionId))
        return NextResponse.json({ error: 'This section does not have a table.' }, { status: 400 })
      if (!Array.isArray(body.table))
        return NextResponse.json({ error: 'table must be a list of rows' }, { status: 400 })
      if (body.table.length > MAX_TABLE_ROWS)
        return NextResponse.json({ error: `A table can have at most ${MAX_TABLE_ROWS} rows.` }, { status: 400 })
      // Reject rather than silently truncate: this is the live autosave path, so the user
      // should see an error for something that big instead of losing the tail.
      if (body.table.some((row: any) =>
        row && Object.values(row).some((v: any) => typeof v === 'string' && v.length > MAX_TABLE_CELL_LENGTH)))
        return NextResponse.json(
          { error: `A table cell is too long (max ${MAX_TABLE_CELL_LENGTH.toLocaleString()} characters).` },
          { status: 400 })
      patch = { table: sanitizeTableRows(body.sectionId, body.table) }
    } else if (body.content !== undefined) {
      if (typeof body.content !== 'string')
        return NextResponse.json({ error: 'content must be text' }, { status: 400 })
      if (isTableSection(body.sectionId))
        return NextResponse.json({ error: 'This section is a table — edit its rows instead.' }, { status: 400 })
      if (body.content.length > MAX_SECTION_CONTENT_LENGTH)
        return NextResponse.json(
          { error: `Section content is too long (max ${MAX_SECTION_CONTENT_LENGTH.toLocaleString()} characters).` },
          { status: 400 })
      patch = { content: sanitizeRichText(body.content) }
    } else if (body.visible !== undefined) {
      if (typeof body.visible !== 'boolean')
        return NextResponse.json({ error: 'visible must be true or false' }, { status: 400 })
      if (REQUIRED_SECTION_IDS.includes(body.sectionId) && body.visible === false)
        return NextResponse.json({ error: 'This section is required and can\'t be hidden.' }, { status: 400 })
      patch = { visible: body.visible }
    } else {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    // Atomic single-section merge (migration 057). Falls back to a guarded whole-array
    // write only if the function isn't installed yet or the section predates the stored
    // array (hydrated in memory above).
    const storedHasSection = Array.isArray(sow.sections) && sow.sections.some((s: any) => s?.id === body.sectionId)
    if (storedHasSection) {
      const { data: applied, error: rpcErr } = await (service as any)
        .rpc('sow_apply_section_patch', { p_sow_id: id, p_section_id: body.sectionId, p_patch: patch })
      if (!rpcErr) {
        if (!applied) return NextResponse.json({ error: LOCKED_MSG }, { status: 409 })
        return NextResponse.json({ ok: true })
      }
      console.error('sow_apply_section_patch unavailable, falling back to guarded array write:', rpcErr.message)
    }
    const merged = hydrated.map((s: any) => (s.id === body.sectionId ? { ...s, ...patch } : s))
    const ok = await guardedUpdate({ sections: merged })
    if (!ok) return NextResponse.json({ error: LOCKED_MSG }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('SOW PATCH error:', err)
    return NextResponse.json({ error: 'Could not save this section. Please try again.' }, { status: 500 })
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents')
      // FIX (section-9 audit, 9-B9): signed_by was never selected, but
      // app/(app)/projects/[id]/sow/[sowId]/page.tsx renders
      // `Signed {date} by {sow.signed_by}` — which printed "by undefined"
      // on every signed SOW.
      .select('id, version, status, sent_at, signed_at, signed_by, sections, metadata, expires_at, project_id, projects(contract_value, currency)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    // FIX (re-audit, section-9 pass): this select used to include `token`
    // — the raw client-portal signing JWT — and returned it unconditionally
    // to any project-assigned viewer regardless of EDIT_SOW/SEND_SOW. No
    // frontend consumer ever read sow.token from this response (send/
    // remind/withdraw all fetch it server-side from the DB directly), so
    // it was pure over-exposure: a low-permission viewer who copied it
    // could hit /api/portal/sow/[token]/sign directly and sign as the
    // client, with the route hardcoding signer_email to the client's own
    // address regardless of who actually submits. Dropped from the select.
    // FIX (re-audit): the editor page (app/(app)/projects/[id]/sow/[sowId]/page.tsx)
    // derived canEdit/canSend purely from isLocked, with no awareness of the
    // caller's actual permissions — it relied entirely on the entry-point
    // link in ProjectDetail.tsx being hidden for users without EDIT_SOW/
    // SEND_SOW. A direct or bookmarked URL visit by someone lacking those
    // permissions saw a fully "live" editor that just 403'd on save,
    // surfacing as a confusing generic "Save failed". Return the real
    // permission flags so the page can gate itself too.
    return NextResponse.json({
      // FIX (section-9 audit, 9-G9): backfill any section this SOW
      // predates, so an older document can still be completed and sent.
      sow: {
        ...sow,
        sections: hydrateSections(sow.sections || [], sow.metadata),
        // Flattened for the editor — it needs these to show the Payment
        // Schedule running total (9-G6).
        contractValue: hasPermission(session, 'VIEW_FINANCIALS') ? (sow.projects?.contract_value ?? null) : null,
        currency:      sow.projects?.currency ?? null,
        // The nested join is only for the flattened fields above — never ship the raw
        // contract value to a member who can't view financials.
        projects:      undefined,
      },
      permissions: {
        canEdit: hasPermission(session, 'EDIT_SOW'),
        canSend: hasPermission(session, 'SEND_SOW'),
        // FIX (section-9 re-audit): api/pdf/sow/[id] now 403s for a viewer
        // without VIEW_FINANCIALS (same fix as the invoice PDF route,
        // applied here — see that route's comment). SowEditor's
        // "Download PDF" link had nothing to gate that on; without this
        // flag it would keep linking to a route that now always fails for
        // exactly the viewers contractValue is already redacted for above.
        canViewFinancials: hasPermission(session, 'VIEW_FINANCIALS'),
      },
    })
  } catch {
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}
