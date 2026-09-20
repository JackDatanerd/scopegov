export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sendCoDocument } from '@/lib/documents/send-co'
import { evaluateApprovalGate } from '@/lib/approvals/engine'
import { canReadProject } from '@/lib/utils/project-access'
import { isTerminalStatus } from '@/lib/utils/project-status'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS' }, { status: 403 })
    if (!session.emailVerifiedAt)
      return NextResponse.json({ error: 'Please verify your email before sending change orders' }, { status: 403 })

    const service = createServiceClient()

    // FIX (carried forward): 'currency' isn't a column on change_orders —
    // it lives on projects. Selecting it here makes PostgREST reject the
    // whole query (42703), which silently surfaces as "CO not found".
    const { data: co, error: coFetchErr } = await (service as any)
      .from('change_orders')
      .select(`id,title,status,total,line_items,version,project_id,
        projects(id,name,status,currency)`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) {
      console.error('CO send: lookup failed', { id, workspaceId: session.workspaceId, error: coFetchErr })
      return NextResponse.json({ error: 'CO not found' }, { status: 404 })
    }
    // FIX (audit round 3): see lib/utils/project-access.ts — same
    // workspace-only-scoping gap as the rest of the CO surface.
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (co.status !== 'draft')
      return NextResponse.json({ error: 'Only draft COs can be sent' }, { status: 400 })
    // FIX (Projects & Dashboard deep audit, flagship finding): checked here
    // too (not just inside sendCoDocument) so a terminal project fails
    // fast, before an approval gate even creates a request for a CO that
    // could never actually be sent.
    if (isTerminalStatus(co.projects?.status || ''))
      return NextResponse.json({
        error: `This project is ${co.projects.status.toLowerCase()} — a change order can no longer be sent. Reopen the project first.`,
      }, { status: 409 })

    // FIX (doc-completeness audit, Group E — hard block): nothing
    // previously stopped an empty or $0 change order from being sent —
    // the client would be asked to accept/decline/sign a document that
    // describes no actual work.
    const lineItems = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])
    if (lineItems.length === 0)
      return NextResponse.json({ error: 'Add at least one line item before sending this change order.' }, { status: 400 })
    if (!co.total || co.total <= 0)
      return NextResponse.json({ error: 'This change order has no value — add line item amounts before sending.' }, { status: 400 })
    // FIX (CO-logic fix round): this pair of checks confirmed the CO had
    // *some* value but never confirmed any individual line item said what
    // that value was for. computeCoTotals validates quantity/rate/length
    // but never required description — a line item with a real rate and a
    // blank description passed both checks above and reached the client
    // (and the PDF) as a billed amount with nothing describing it. Kept
    // here rather than in computeCoTotals so a draft can still be saved
    // mid-edit with an item that has a rate but no description yet — this
    // only blocks it from being sent to the client in that state.
    if (lineItems.some((li: any) => (li.total || 0) > 0 && !String(li.description || '').trim()))
      return NextResponse.json({ error: 'Every line item with a value needs a description.' }, { status: 400 })

    const project = co.projects
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // FIX (CO-logic fix round): backstop for the same check now applied at
    // creation time in POST /api/co — kept here too since this route has
    // no way to know whether a given CO predates that check, or the
    // project's signed SOW was somehow withdrawn/reopened after this CO
    // was drafted. Cheaper to catch here than to let the client discover
    // it at finalize-co.ts's own hard block after signing.
    const { data: signedSow } = await (service as any)
      .from('sow_documents').select('id')
      .eq('project_id', co.project_id).eq('status', 'signed')
      .limit(1).maybeSingle()
    if (!signedSow) {
      return NextResponse.json({
        error: 'This project has no signed SOW yet — a change order can only be sent once the original scope of work is signed.',
      }, { status: 409 })
    }

    // Phase 3 — Approval Chains: gate on the CO's own total, not the
    // project's overall contract value — a $500 CO on a $200k retainer
    // shouldn't trip a $10k threshold meant for large scope additions.
    // Document numbering (Phase 0) only happens once send actually fires
    // inside sendCoDocument, so a gated-but-not-yet-approved CO stays
    // un-numbered — consistent with numbers only ever being burned by a
    // real send.
    const gate = await evaluateApprovalGate(service, {
      workspaceId:  session.workspaceId,
      documentType: 'co',
      documentId:   id,
      projectId:    project.id,
      projectName:  project.name,
      amount:       co.total || 0,
      currency:     project.currency || 'USD',
      documentTitle: co.title,
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

    const result = await sendCoDocument(service, {
      coId: id,
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
    })

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, token: result.token, portalUrl: result.portalUrl, documentNumber: result.documentNumber })
  } catch (err) {
    console.error('CO send error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
