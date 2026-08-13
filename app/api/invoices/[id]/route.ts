export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_FINANCIALS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices')
      .select(`*, projects(id, name, currency, clients(id, name, company_name, email)),
        payment_milestones(id, title), sow_documents(id, document_number),
        change_orders(id, title, document_number)`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: payments } = await (service as any)
      .from('invoice_payments')
      .select('id, amount, paid_at, method, reference_note, recorded_by, created_at, users(name)')
      .eq('invoice_id', id)
      .order('paid_at', { ascending: false })

    return NextResponse.json({ invoice, payments: payments || [] })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

// PATCH — only draft invoices are editable; once sent, the amount/title
// are what the client saw and shouldn't silently change underneath them.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices').select('id, status, title, project_id')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (invoice.status !== 'draft')
      return NextResponse.json({ error: 'Only draft invoices can be edited — void and re-create instead' }, { status: 400 })

    const body = await request.json()
    const update: Record<string, any> = { updated_at: new Date().toISOString() }
    if (body.title !== undefined) update.title = String(body.title).trim()
    if (body.amount !== undefined) {
      const n = Number(body.amount)
      if (!n || n <= 0) return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 })
      update.amount = n
    }
    if (body.dueDate !== undefined) update.due_date = body.dueDate || null
    if (body.paymentInstructions !== undefined) update.payment_instructions = body.paymentInstructions?.trim() || null
    if (body.notes !== undefined) update.notes = body.notes?.trim() || null

    const { error } = await (service as any).from('invoices').update(update).eq('id', id)
    if (error) return NextResponse.json({ error: 'Failed to update invoice' }, { status: 500 })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

// DELETE — hard-delete only ever allowed while still a draft (nothing sent
// to a client yet, no audit trail expectation attached). Once sent, use void.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices').select('id, status, title, project_id')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (invoice.status !== 'draft')
      return NextResponse.json({ error: 'Only draft invoices can be deleted — void a sent invoice instead' }, { status: 400 })

    await (service as any).from('invoices').delete().eq('id', id)

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.deleted', entityType: 'invoice',
      entityId: id, entityName: invoice.title,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
