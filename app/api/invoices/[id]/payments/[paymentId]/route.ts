export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { parseDateOnly } from '@/lib/documents/invoice-totals'
import { roundCurrency } from '@/lib/utils/format'

const VALID_METHODS = ['bank_transfer', 'stripe', 'check', 'cash', 'other']

// PATCH — FEATURE (section-12 audit, pass 2): correct a payment's amount, date,
// method or reference in place. Previously the only way to fix a typo (a wrong
// date, an amount off by a digit) was to delete the payment and re-enter it,
// which momentarily un-paid the invoice (and could re-fire 'paid' side effects).
// The overpayment guard trigger (migration 016) covers UPDATE as well as INSERT.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> }
) {
  try {
    const { id, paymentId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices').select('id, title, project_id, status').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (invoice.status === 'void' || invoice.status === 'draft')
      return NextResponse.json({ error: "Payments on a draft or voided invoice can't be edited" }, { status: 400 })

    const { data: payment } = await (service as any)
      .from('invoice_payments').select('id, amount, paid_at, method, reference_note').eq('id', paymentId).eq('invoice_id', id).single()
    if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 })

    const update: Record<string, any> = {}
    if (body.amount !== undefined) {
      const raw = Number(body.amount)
      if (!Number.isFinite(raw) || raw <= 0 || raw > 1_000_000_000_000)
        return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 })
      const amount = roundCurrency(raw)
      if (amount <= 0) return NextResponse.json({ error: 'Amount must be at least 0.01' }, { status: 400 })
      update.amount = amount
    }
    if (body.paidAt !== undefined) {
      const paidAt = parseDateOnly(body.paidAt)
      if (!paidAt) return NextResponse.json({ error: 'Date received must be a valid date' }, { status: 400 })
      if (paidAt > new Date(Date.now() + 86400000).toISOString().slice(0, 10))
        return NextResponse.json({ error: "Date received can't be in the future" }, { status: 400 })
      update.paid_at = paidAt
    }
    if (body.method !== undefined) {
      if (!VALID_METHODS.includes(body.method)) return NextResponse.json({ error: 'Unknown payment method' }, { status: 400 })
      update.method = body.method
    }
    if (body.referenceNote !== undefined) {
      if (body.referenceNote !== null && typeof body.referenceNote !== 'string')
        return NextResponse.json({ error: 'Reference note must be text' }, { status: 400 })
      const note = (body.referenceNote || '').trim()
      if (note.length > 500) return NextResponse.json({ error: 'Reference note must be under 500 characters' }, { status: 400 })
      update.reference_note = note || null
    }
    if (Object.keys(update).length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })

    const { error } = await (service as any).from('invoice_payments').update(update).eq('id', paymentId).eq('invoice_id', id)
    if (error) {
      if (error.message?.includes('exceed invoice balance'))
        return NextResponse.json({ error: 'That amount would take the payments past the invoice total.' }, { status: 409 })
      console.error('Invoice payment update error:', error)
      return NextResponse.json({ error: 'Failed to update payment' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.payment_updated', entityType: 'invoice',
      entityId: id, entityName: invoice.title,
      metadata: {
        before: { amount: payment.amount, paid_at: payment.paid_at, method: payment.method, reference_note: payment.reference_note },
        after: update,
      },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice payment update error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

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
      .from('invoices').select('id, title, project_id, status').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    // Payments on a voided invoice are the record that money was received (voiding
    // an invoice with payments keeps them on file) — they are not to be deleted.
    if (invoice.status === 'void')
      return NextResponse.json({ error: "Payments on a voided invoice are kept as the record of money received and can't be removed" }, { status: 400 })

    const { data: payment } = await (service as any)
      .from('invoice_payments').select('id, amount, paid_at, method, reference_note').eq('id', paymentId).eq('invoice_id', id).single()
    if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 })

    const { error } = await (service as any).from('invoice_payments').delete().eq('id', paymentId)
    if (error) return NextResponse.json({ error: 'Failed to remove payment' }, { status: 500 })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.payment_removed', entityType: 'invoice',
      entityId: id, entityName: invoice.title,
      metadata: { amount: payment.amount, paid_at: payment.paid_at, method: payment.method, reference_note: payment.reference_note },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice payment delete error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
