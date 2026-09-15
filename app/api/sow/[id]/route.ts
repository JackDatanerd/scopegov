import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sanitizeRichText, sanitizePlainText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
import { isTableSection, SOW_TABLE_SCHEMAS, type SowTableSectionId } from '@/lib/sow/table-schema'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'

// Table rows are plain-text cells (rendered on the public portal page same
// as prose content) — sanitizePlainText, not sanitizeRichText, since a
// table cell was never meant to carry markup, only sanitized against
// injection. Unknown keys are dropped rather than passed through so a
// tampered PATCH body can't smuggle arbitrary fields into stored rows.
function sanitizeTableRows(sectionId: string, rows: unknown): Array<Record<string, string>> {
  if (!isTableSection(sectionId) || !Array.isArray(rows)) return []
  const schema = SOW_TABLE_SCHEMAS[sectionId as SowTableSectionId]
  return rows.map((row: any) => {
    const clean: Record<string, string> = {}
    for (const col of schema.columns) clean[col.key] = sanitizePlainText(row?.[col.key] ?? '')
    return clean
  })
}

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
      .select('id, status, sent_at, sections, project_id')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts — GET/PATCH
    // here only checked workspace_id, letting a VIEW_OWN_PROJECTS-only
    // member with EDIT_SOW read or edit SOW documents for projects they
    // aren't assigned to.
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Lock check — sentAt makes document permanently read-only (spec §0.6)
    if (sow.sent_at)
      return NextResponse.json({ error: 'SOW is locked after sending. Withdraw to edit.' }, { status: 409 })

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

    // FIX (audit round 1, item #2): section content is rendered raw via
    // dangerouslySetInnerHTML on the public, unauthenticated portal page —
    // sanitize here (not just trust the TipTap editor's own constraints,
    // which this API route bypasses entirely) so stored XSS can't reach
    // storage in the first place. See lib/utils/sanitize.ts.
    let newSections = sow.sections || []
    if (body.sections) {
      newSections = (body.sections as any[]).map(s => ({
        ...s,
        content: sanitizeRichText(s.content),
        ...(isTableSection(s.id) ? { table: sanitizeTableRows(s.id, s.table) } : {}),
      }))
    } else if (body.sectionId && body.table !== undefined) {
      const safeTable = sanitizeTableRows(body.sectionId, body.table)
      newSections = newSections.map((s: any) =>
        s.id === body.sectionId ? { ...s, table: safeTable } : s
      )
    } else if (body.sectionId && body.content !== undefined) {
      const safeContent = sanitizeRichText(body.content)
      newSections = newSections.map((s: any) =>
        s.id === body.sectionId ? { ...s, content: safeContent } : s
      )
    } else if (body.sectionId && body.visible !== undefined) {
      newSections = newSections.map((s: any) =>
        s.id === body.sectionId ? { ...s, visible: body.visible } : s
      )
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
      .select('id, version, status, sent_at, signed_at, sections, metadata, expires_at, token, project_id')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    // FIX (re-audit): the editor page (app/(app)/projects/[id]/sow/[sowId]/page.tsx)
    // derived canEdit/canSend purely from isLocked, with no awareness of the
    // caller's actual permissions — it relied entirely on the entry-point
    // link in ProjectDetail.tsx being hidden for users without EDIT_SOW/
    // SEND_SOW. A direct or bookmarked URL visit by someone lacking those
    // permissions saw a fully "live" editor that just 403'd on save,
    // surfacing as a confusing generic "Save failed". Return the real
    // permission flags so the page can gate itself too.
    return NextResponse.json({
      sow,
      permissions: {
        canEdit: hasPermission(session, 'EDIT_SOW'),
        canSend: hasPermission(session, 'SEND_SOW'),
      },
    })
  } catch {
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}
