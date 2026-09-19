export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'

// DELETE — corrects a mis-entered payment. The trg_invoice_payments_recalc
// trigger (004_invoicing.sql) recomputes invoices.amount_paid/status the
// moment the row is gone, so there's nothing else to reconcile here.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> }
) {
  try {
    const { id, paymentId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices').select('id, title, project_id').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: payment } = await (service as any)
      .from('invoice_payments').select('id, amount').eq('id', paymentId).eq('invoice_id', id).single()
    if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 })

    const { error } = await (service as any).from('invoice_payments').delete().eq('id', paymentId)
    if (error) return NextResponse.json({ error: 'Failed to remove payment' }, { status: 500 })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.payment_removed', entityType: 'invoice',
      entityId: id, entityName: invoice.title, metadata: { amount: payment.amount },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice payment delete error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
