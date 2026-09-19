export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { sendInvoicePaymentRecordedEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { canReadProject } from '@/lib/utils/project-access'

const VALID_METHODS = ['bank_transfer', 'stripe', 'check', 'cash', 'other']

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_FINANCIALS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices').select('id, project_id').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: payments } = await (service as any)
      .from('invoice_payments')
      .select('id, amount, paid_at, method, reference_note, recorded_by, created_at, users(name)')
      .eq('invoice_id', id).order('paid_at', { ascending: false })

    return NextResponse.json({ payments: payments || [] })
  } catch (err) {
    console.error('Invoice payments list error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST — record a payment an agency user received OUTSIDE ScopeGov (wire,
// their own Stripe invoice, check, cash). There is no gateway here; this
// is a manual ledger entry, and recorded_by is always the logging user.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const body = await request.json()
    const amount = Number(body?.amount)
    const paidAt: string | undefined = body?.paidAt
    const method: string = VALID_METHODS.includes(body?.method) ? body.method : 'other'
    const referenceNote: string | undefined = body?.referenceNote?.trim()

    if (!amount || amount <= 0)
      return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 })
    if (!paidAt) return NextResponse.json({ error: 'paidAt (date received) is required' }, { status: 400 })

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices')
      // FIX (re-audit): project_id was missing from this select, so
      // invoice.project_id below was always undefined — which silently
      // skipped the project-scoped notification filtering in
      // lib/utils/permissions-query.ts (the fix from audit round 4,
      // finding #8). A VIEW_FINANCIALS holder restricted to specific
      // projects (not VIEW_ALL_PROJECTS) was still getting email + in-app
      // notifications, including client name and dollar amount, for
      // payments on projects they have no access to. Every other invoice
      // route already selects project_id directly for exactly this reason
      // — this one just missed it.
      // FIX (section-12 audit): invoice_number wasn't selected either, so
      // the payment-recorded email below always passed
      // `invoiceNumber: undefined` — the template degrades gracefully
      // (falls back to generic "Payment received" copy) rather than
      // rendering literally "undefined", so this wasn't broken, just less
      // useful than it could be for a project with more than one
      // invoice.
      .select(`id, title, amount, amount_paid, currency, status, project_id, invoice_number,
        projects(id, name, clients(name), workspaces(agency_name))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.projects?.id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!['sent', 'partially_paid', 'overdue'].includes(invoice.status))
      return NextResponse.json({ error: 'Payments can only be recorded on a sent, unpaid invoice' }, { status: 400 })

    const remaining = Number(invoice.amount) - Number(invoice.amount_paid)
    if (amount - remaining > 0.005) // small epsilon for float rounding
      return NextResponse.json({
        error: `Payment of ${amount} exceeds the remaining balance of ${remaining.toFixed(2)}`,
      }, { status: 400 })

    const { data: payment, error } = await (service as any)
      .from('invoice_payments')
      .insert({
        invoice_id: id, amount, paid_at: paidAt, method,
        reference_note: referenceNote || null, recorded_by: session.id,
      })
      .select('id, amount, paid_at, method, reference_note')
      .single()

    if (error) {
      // FIX (re-audit, race-condition finding): the app-layer `remaining`
      // check above is a read-then-write race (two concurrent payment
      // submissions can both read the balance before either commits) —
      // the real backstop is the DB trigger added in migration 016,
      // which locks the invoice row and rejects an overpaying insert.
      // Surface that specific rejection as a normal 400, not a generic
      // 500 — it's an expected outcome of the race, not a server fault.
      if (error.message?.includes('exceed invoice balance')) {
        return NextResponse.json({
          error: 'This payment would exceed the invoice balance — someone may have just recorded another payment on it. Refresh and try again.',
        }, { status: 409 })
      }
      console.error('Invoice payment insert error:', error)
      return NextResponse.json({ error: 'Failed to record payment' }, { status: 500 })
    }

    // trg_invoice_payments_recalc (003_...sql / 004_...sql) already updated
    // invoices.amount_paid + status — re-read for the accurate post-write state.
    const { data: refreshed } = await (service as any)
      .from('invoices').select('amount, amount_paid, status').eq('id', id).single()

    const isFullyPaid = refreshed?.status === 'paid'
    const balanceRemaining = Math.max(0, Number(refreshed?.amount || 0) - Number(refreshed?.amount_paid || 0))

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.payment_recorded', entityType: 'invoice',
      entityId: id, entityName: invoice.title,
      metadata: { amount, method, is_fully_paid: isFullyPaid },
    })

    await notifyMembersWithPermission(service, {
      workspaceId: session.workspaceId, permission: 'VIEW_FINANCIALS',
      eventType: 'invoice_payment_received',
      type: isFullyPaid ? 'invoice_paid' : 'invoice_payment_received',
      title: isFullyPaid ? `Invoice paid in full — ${invoice.projects?.name}` : `Payment received — ${invoice.projects?.name}`,
      body: `${invoice.projects?.clients?.name || 'Client'} paid ${invoice.currency} ${amount.toLocaleString()} on "${invoice.title}"`,
      // FIX (audit): entity_type was 'invoice' with entityId = invoice id, but
      // NotificationBell's entityHref() only resolves 'project' / 'project_message'
      // / 'approval_request' — clicking these notifications did nothing. Point at
      // the project's Billing tab instead, matching the pattern every other
      // notification type already uses.
      entityType: 'project', entityId: invoice.project_id, excludeUserId: session.id, projectId: invoice.project_id,
    })

    try {
      const emails = await getMemberEmailsWithPermission(service, session.workspaceId, 'VIEW_FINANCIALS', 10, 'invoice_payment_received', invoice.project_id)
      if (emails.length) {
        await sendInvoicePaymentRecordedEmail({
          to: emails,
          agencyName: invoice.projects?.workspaces?.agency_name,
          clientName: invoice.projects?.clients?.name || 'Client',
          projectName: invoice.projects?.name,
          invoiceNumber: invoice.invoice_number || undefined,
          amount, currency: invoice.currency, isFullyPaid, balanceRemaining,
          projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${invoice.projects?.id}?tab=billing`,
        })
      }
    } catch (e) { console.error('Payment recorded email failed:', e) }

    return NextResponse.json({ ok: true, payment, invoice: refreshed })
  } catch (err) {
    console.error('Invoice payment error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
