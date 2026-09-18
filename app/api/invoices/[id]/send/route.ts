export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { sendInvoiceDocument } from '@/lib/documents/send-invoice'
import { evaluateApprovalGate } from '@/lib/approvals/engine'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })
    if (!session.emailVerifiedAt)
      return NextResponse.json({ error: 'Please verify your email before sending invoices' }, { status: 403 })

    const service = createServiceClient()

    // Fetch just enough to validate completeness and run the approval gate
    // before touching send mechanics — the full fetch, document numbering,
    // PDF generation, and emails all happen inside sendInvoiceDocument
    // (lib/documents/send-invoice.ts), same split as SOW/CO.
    const { data: invoice } = await (service as any)
      .from('invoices')
      .select('id, title, amount, currency, status, due_date, payment_instructions, project_id, projects(id, name)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.projects?.id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (invoice.status !== 'draft')
      return NextResponse.json({ error: 'Only draft invoices can be sent' }, { status: 400 })

    const project = invoice.projects
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    if (!invoice.due_date)
      return NextResponse.json({ error: 'Add a due date before sending this invoice.' }, { status: 400 })
    if (!invoice.payment_instructions?.trim())
      return NextResponse.json({ error: 'Add payment instructions before sending this invoice.' }, { status: 400 })

    // FIX (section-12 audit — flagship feature gap): invoices previously
    // had no approval gate at all, despite document_type being free-text
    // specifically so 'invoice' could be added here without a migration
    // (see lib/approvals/engine.ts's header) — Phase 4a (this feature)
    // shipped without ever wiring it up. An agency that has carefully
    // configured "COs over $10k need sign-off" had zero equivalent
    // protection on an invoice of any size reaching a client. Same
    // pattern as the SOW/CO send routes: halt here and wait on sign-off
    // if a matching workflow exists; the invoice stays 'draft' and
    // un-numbered until the chain clears, then the engine sends it
    // automatically.
    const gate = await evaluateApprovalGate(service, {
      workspaceId:  session.workspaceId,
      documentType: 'invoice',
      documentId:   id,
      projectId:    project.id,
      projectName:  project.name,
      amount:       invoice.amount || 0,
      currency:     invoice.currency || 'USD',
      documentTitle: `Invoice — ${invoice.title} — ${project.name}`,
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

    const result = await sendInvoiceDocument(service, {
      invoiceId: id,
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      actorAgencyName: session.agencyName,
    })

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, token: result.token, portalUrl: result.portalUrl, invoiceNumber: result.invoiceNumber })
  } catch (err) {
    console.error('Invoice send error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
