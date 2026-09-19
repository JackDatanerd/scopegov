export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sendSowDocument } from '@/lib/documents/send-sow'
import { evaluateApprovalGate } from '@/lib/approvals/engine'
import { canReadProject } from '@/lib/utils/project-access'
import { parseTableAmount } from '@/lib/sow/table-schema'
import { roundCurrency } from '@/lib/utils/format'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_SOW'))
      return NextResponse.json({ error: 'Missing permission: SEND_SOW' }, { status: 403 })

    // Email must be verified to send (spec §16.0)
    if (!session.emailVerifiedAt)
      return NextResponse.json({ error: 'Please verify your email before sending SOWs' }, { status: 403 })

    const service = createServiceClient()

    // Fetch just enough to run the approval gate before touching send
    // mechanics — full fetch + document numbering + JWT issuance happens
    // inside sendSowDocument (lib/documents/send-sow.ts).
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, status, project_id, sections, metadata,
        projects(id, name, disc, contract_value, currency)`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (sow.status !== 'draft')
      return NextResponse.json({ error: 'Only draft SOWs can be sent' }, { status: 400 })

    const project = sow.projects
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // FIX (doc-completeness audit, Group E — hard block): nothing
    // previously stopped a SOW with a $0 contract value or with every
    // section hidden/empty from being sent to a client for signature.
    const visibleSections = (sow.sections || []).filter((s: any) => s.visible !== false && s.content?.trim())
    if (visibleSections.length === 0)
      return NextResponse.json({ error: 'Add at least one visible section before sending this SOW.' }, { status: 400 })
    if (!project.contract_value || project.contract_value <= 0)
      return NextResponse.json({ error: 'Set a contract value greater than zero before sending this SOW.' }, { status: 400 })

    // FEATURE (section-9 audit follow-up): the sign route's
    // createMilestones() reads the payment_schedule table directly and
    // will only use it if the rows foot exactly to the contract value —
    // otherwise it falls back to a single lump-sum milestone and flags it
    // in the audit log. That fallback exists purely as a backstop; the
    // agency should never actually see it in practice. Catching a
    // mis-totaled schedule HERE, before the SOW ever reaches the client,
    // is far better than discovering it after signature — the client
    // would have agreed to a document whose payment schedule doesn't
    // match its own numbers.
    if (sow.metadata?.paymentStructure === 'milestones') {
      const scheduleSection = (sow.sections || []).find((s: any) => s.id === 'payment_schedule')
      const rows: any[] = Array.isArray(scheduleSection?.table) ? scheduleSection.table : []

      // FIX (section-9 audit, 9-G6): `Number(r.amount)` on a free-text
      // cell treats "1,500" as NaN, so a valid-looking schedule failed
      // this check for reasons the agency could not see on screen. See
      // parseTableAmount in lib/sow/table-schema.ts.
      const parsed = rows.map((r: any) => ({
        milestone: String(r?.milestone || '').trim(),
        amount:    parseTableAmount(r?.amount),
      }))

      const unreadable = parsed.filter(r => r.milestone && r.amount === null)
      if (unreadable.length > 0)
        return NextResponse.json({
          error: `Couldn't read the amount on the Payment Schedule milestone "${unreadable[0].milestone}". Enter a plain number.`,
        }, { status: 400 })

      const validRows = parsed.filter(r => r.milestone && (r.amount ?? 0) > 0)
      if (validRows.length === 0)
        return NextResponse.json({ error: 'Add at least one milestone to the Payment Schedule before sending this SOW.' }, { status: 400 })

      // FIX (section-9 audit, 9-G6 follow-on): this validated the
      // schedule even when the section was hidden — so a client could be
      // sent a SOW whose Payment Terms says "Payable in milestones as
      // defined below" with no schedule anywhere in the document, while
      // the agency was still forced to make the invisible table foot to
      // the cent. If the structure is milestones, the schedule is part of
      // the agreement and has to be on the page.
      if (scheduleSection?.visible === false)
        return NextResponse.json({
          error: 'This SOW uses a milestone payment structure — un-hide the Payment Schedule section before sending it.',
        }, { status: 400 })

      const scheduleSum = roundCurrency(validRows.reduce((s: number, r) => s + (r.amount as number), 0))
      if (Math.abs(scheduleSum - project.contract_value) >= 0.01)
        return NextResponse.json({
          error: `The Payment Schedule totals ${scheduleSum.toFixed(2)} but the contract value is ${Number(project.contract_value).toFixed(2)} — these must match before sending.`,
        }, { status: 400 })
    }

    // Phase 3 — Approval Chains: if a workflow matches this SOW's contract
    // value, halt here and wait on sign-off instead of sending. The
    // document stays 'draft' (and un-numbered — Phase 0 only assigns a
    // document number once send actually happens); approvers act via
    // /api/approvals/[id]/approve and the engine sends it automatically
    // once the chain clears.
    const gate = await evaluateApprovalGate(service, {
      workspaceId:  session.workspaceId,
      documentType: 'sow',
      documentId:   id,
      projectId:    project.id,
      projectName:  project.name,
      amount:       project.contract_value || 0,
      currency:     project.currency || 'USD',
      documentTitle: `SOW v${sow.version} — ${project.name}`,
      requestedBy:  { id: session.id, name: session.name, email: session.email },
    })

    if (gate.requiresApproval) {
      return NextResponse.json({
        ok: true,
        pendingApproval: true,
        approvalRequestId: gate.approvalRequestId,
        message: 'Sent for approval — the client will be notified once it clears.',
      })
    }

    const result = await sendSowDocument(service, {
      sowId: id,
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
    })

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, token: result.token, portalUrl: result.portalUrl, documentNumber: result.documentNumber })
  } catch (err) {
    console.error('SOW send error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
