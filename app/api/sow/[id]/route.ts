import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sanitizeRichText, sanitizePlainText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
// NOTE: helpers live in lib/sow/sections.ts, not here — a Next.js route
// module may only export route handlers, so exporting them from this file
// failed the production build ("hydrateSections is not a valid Route
// export field") even though `tsc --noEmit` was perfectly happy.
import { REQUIRED_SECTION_IDS, hydrateSections, sanitizeSectionList, sanitizeTableRows, MAX_SECTION_CONTENT_LENGTH, MAX_TABLE_CELL_LENGTH } from '@/lib/sow/sections'
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

    const body = await request.json()

    // FIX (section-9 audit, 9-G4 — feature gap): metadata.msaReference has
    // been declared, read, and rendered on the PDF masthead across three
    // call sites (this route's own GET/PDF sibling, api/pdf/sow/[id],
    // api/portal/sow/[token]/pdf, .../sign) since a prior pass — but that
    // pass only wired the READ side. Nothing anywhere ever wrote it: no
    // field in SowEditor, no API branch here accepted it. A fully
    // unreachable feature. This is the write side, handled as its own
    // independent update (no section content involved) — sanitized as
    // plain text (it's rendered as a bare masthead line, not rich text)
    // and length-capped the same way other free-text SOW fields are.
    if (body.msaReference !== undefined) {
      const safeMsaReference = sanitizePlainText(body.msaReference).slice(0, 200) || null
      const { error: metaErr } = await (service as any)
        .from('sow_documents')
        .update({
          metadata:   { ...(sow.metadata || {}), msaReference: safeMsaReference },
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
      if (metaErr) throw new Error(metaErr.message)
      return NextResponse.json({ ok: true })
    }

    // FIX (audit round 1, item #2): section content is rendered raw via
    // dangerouslySetInnerHTML on the public, unauthenticated portal page —
    // sanitize here (not just trust the TipTap editor's own constraints,
    // which this API route bypasses entirely) so stored XSS can't reach
    // storage in the first place. See lib/utils/sanitize.ts.
    // Hydrate first (9-G9) so a per-section PATCH against a section this
    // SOW predates actually lands instead of silently no-op'ing through
    // the .map() calls below.
    let newSections = hydrateSections(sow.sections || [], sow.metadata)
    if (body.sections) {
      // FIX (section-9 audit, 9-B13): this used to spread `...s` wholesale
      // from the request body. Only `content` was sanitized — `id`,
      // `title`, `order` and `visible` were taken verbatim, so a caller
      // could rename "Governing Law" to anything, reorder the document,
      // inject sections that don't exist in SOW_SECTION_DEFS, or drop the
      // mandatory ones entirely. Send's only structural check is "at
      // least one visible section with content", so a SOW with no
      // Signatures and no Governing Law section would sail straight
      // through to a client for signature.
      //
      // The section list is server-owned (that's the whole design of
      // lib/ai/sow-content.ts — "The server owns the section structure
      // and JSON shape completely"). Enforce it here too: keep the
      // canonical id/title/order, take only content/visible/table from
      // the client, and ignore unknown ids.
      newSections = sanitizeSectionList(body.sections, sow.sections || [], sow.metadata)
    } else if (body.sectionId && body.table !== undefined) {
      // FIX (section-9 audit, no-length-cap finding): reject rather than
      // silently truncate here — this is the live autosave path
      // (components/sow/SowEditor.tsx), so the user should see an error
      // for something that big rather than have it quietly cut short
      // with no indication anything was lost. See lib/sow/sections.ts.
      if (Array.isArray(body.table) && body.table.some((row: any) =>
        row && Object.values(row).some((v: any) => typeof v === 'string' && v.length > MAX_TABLE_CELL_LENGTH)
      )) {
        return NextResponse.json(
          { error: `A table cell is too long (max ${MAX_TABLE_CELL_LENGTH.toLocaleString()} characters).` },
          { status: 400 }
        )
      }
      const safeTable = sanitizeTableRows(body.sectionId, body.table)
      newSections = newSections.map((s: any) =>
        s.id === body.sectionId ? { ...s, table: safeTable } : s
      )
    } else if (body.sectionId && body.content !== undefined) {
      // FIX (section-9 audit, no-length-cap finding): same reasoning as
      // the table branch above.
      if (typeof body.content === 'string' && body.content.length > MAX_SECTION_CONTENT_LENGTH) {
        return NextResponse.json(
          { error: `Section content is too long (max ${MAX_SECTION_CONTENT_LENGTH.toLocaleString()} characters).` },
          { status: 400 }
        )
      }
      const safeContent = sanitizeRichText(body.content)
      newSections = newSections.map((s: any) =>
        s.id === body.sectionId ? { ...s, content: safeContent } : s
      )
    } else if (body.sectionId && body.visible !== undefined) {
      // FIX (section-9 audit, 9-G10 + 9-B10): the server never enforced
      // REQUIRED_SECTIONS at all — that list only existed in the editor
      // component, so a direct PATCH could hide Signatures or Governing
      // Law. Refuse explicitly rather than silently ignoring it, so the
      // client gets a real error to surface instead of a false "Saved".
      if (REQUIRED_SECTION_IDS.includes(body.sectionId))
        return NextResponse.json(
          { error: 'This section is required and can\'t be hidden.' },
          { status: 400 }
        )
      newSections = newSections.map((s: any) =>
        s.id === body.sectionId ? { ...s, visible: body.visible } : s
      )
    } else {
      // FIX (section-9 audit, 9-B10 follow-on): an unrecognized body shape
      // used to fall through to the update below and return { ok: true },
      // so a malformed save reported success having changed nothing.
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { error } = await (service as any)
      .from('sow_documents')
      .update({ sections: newSections, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
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
        contractValue: sow.projects?.contract_value ?? null,
        currency:      sow.projects?.currency ?? null,
      },
      permissions: {
        canEdit: hasPermission(session, 'EDIT_SOW'),
        canSend: hasPermission(session, 'SEND_SOW'),
      },
    })
  } catch {
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}
