export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'
import { getPendingApprovalForDocument, cancelApprovalRequest } from '@/lib/approvals/engine'

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
    console.error('Invoice detail fetch error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
      .from('invoices').select('id, status, title, amount, subtotal, tax_rate, tax_inclusive, project_id, line_items, milestone_id, co_id, sow_id')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (invoice.status !== 'draft')
      return NextResponse.json({ error: 'Only draft invoices can be edited — void and re-create instead' }, { status: 400 })
    // FIX (section-12 audit — feature gap follow-through): now that
    // invoices can be gated by an approval workflow (see
    // /api/invoices/[id]/send), a gated invoice stays at status:'draft'
    // the entire time it's under review — same pattern as SOW/CO, and the
    // same reason those two routes carry this exact check. Without it, an
    // approver could be reviewing one amount while the requester quietly
    // changes it underneath them before the chain even clears.
    if (await getPendingApprovalForDocument(service, 'invoice', id)) {
      return NextResponse.json(
        { error: 'This invoice has a pending approval request — cancel it before editing.' },
        { status: 409 }
      )
    }

    const body = await request.json()
    const update: Record<string, any> = { updated_at: new Date().toISOString() }
    if (body.title !== undefined) update.title = String(body.title).trim()
    if (body.amount !== undefined) {
      const n = Number(body.amount)
      if (!n || n <= 0) return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 })
      update.amount = n
    }
    if (body.dueDate !== undefined) update.due_date = body.dueDate || null
    if (body.poNumber !== undefined) update.po_number = body.poNumber?.trim().slice(0, 100) || null
    if (body.paymentInstructions !== undefined) update.payment_instructions = sanitizeRichTextOrNull(body.paymentInstructions)
    if (body.notes !== undefined) update.notes = body.notes?.trim() || null

    // Resolve the line items that will be in effect after this PATCH —
    // freshly submitted ones if this call is touching them, otherwise
    // whatever the invoice already has on file (defensively unwrapped in
    // case an older row still has the pre-fix JSON-string encoding).
    let cleanLineItems: Array<{ description: string; quantity: number; rate: number; total: number }> | undefined
    if (body.lineItems !== undefined) {
      cleanLineItems = Array.isArray(body.lineItems)
        ? body.lineItems.map((l: any) => ({
            description: String(l.description || '').trim().slice(0, 500),
            quantity:    Number(l.quantity) || 0,
            rate:        Number(l.rate) || 0,
            total:       Number(l.total) || 0,
          })).filter((l: any) => l.description)
        : []
    }
    const existingLineItems = typeof invoice.line_items === 'string'
      ? JSON.parse(invoice.line_items || '[]') : (invoice.line_items || [])
    const isItemized = (cleanLineItems !== undefined ? cleanLineItems : existingLineItems).length > 0

    // FIX (re-audit): `amount` could be changed here with no recompute of
    // `subtotal`/`tax_rate` at all — editing a draft invoice's amount left
    // the stored tax breakdown referencing the OLD amount, so the
    // next-sent PDF's subtotal+tax could stop summing to the new total.
    // Recompute the same way POST /api/invoices does whenever amount, tax,
    // or line items change, using whichever values are in effect
    // (freshly patched, or the invoice's existing ones).
    const touchesTax = body.amount !== undefined || body.taxRate !== undefined
      || body.taxInclusive !== undefined || cleanLineItems !== undefined
    let finalSubtotal = invoice.subtotal != null ? Number(invoice.subtotal) : Number(invoice.amount)
    if (touchesTax) {
      const finalAmount  = update.amount !== undefined ? update.amount : Number(invoice.amount)
      const finalTaxRate = body.taxRate !== undefined ? (Number(body.taxRate) || 0) : Number(invoice.tax_rate || 0)
      // FIX (section-12 audit): same fix as POST /api/invoices — an
      // itemized invoice's amount is derived from summing its line items
      // (a pre-tax figure by construction, since no per-line tax is ever
      // applied), so it can't simultaneously be treated as "tax-inclusive"
      // without the footing check below permanently failing. Force
      // exclusive whenever line items are (or remain) in effect, the same
      // way creation now does.
      const finalTaxInclusive = isItemized
        ? false
        : (body.taxInclusive !== undefined ? !!body.taxInclusive : !!invoice.tax_inclusive)
      finalSubtotal = finalTaxRate > 0
        ? (finalTaxInclusive ? finalAmount / (1 + finalTaxRate / 100) : finalAmount)
        : finalAmount
      update.subtotal      = finalSubtotal
      update.tax_rate      = finalTaxRate
      update.tax_inclusive = finalTaxInclusive
      // A tax-exclusive rate change grosses the total up, same as creation.
      if (finalTaxRate > 0 && !finalTaxInclusive) update.amount = finalAmount * (1 + finalTaxRate / 100)
    }

    // FIX (section-12 audit, flagship finding — same as POST /api/invoices):
    // the create-time cap against the linked milestone/CO's own value did
    // nothing to stop the amount drifting past it again on a later edit,
    // since this route never even fetched milestone_id/co_id. Only check
    // when the amount/tax actually changed — an edit that only touches the
    // title or due date has nothing to re-validate.
    // FIX (section-12 fix round, flagship finding): this block only ever
    // capped against the linked source's OWN total value in isolation —
    // it never accounted for other non-void invoices already issued
    // against the same milestone/CO/SOW, so editing a draft's amount
    // upward could push the CUMULATIVE total billed against that source
    // past its real value even though this one invoice's own number
    // looked fine in isolation. It also never checked sow_id at all
    // (no cap existed for SOW-linked invoices before this fix — see
    // POST /api/invoices for the matching creation-time fix). The sum
    // below excludes this invoice's own current row so an edit is
    // compared against everything ELSE already billed, not double-counted
    // against itself.
    if (touchesTax) {
      let cap: number | null = null
      let sourceColumn: 'milestone_id' | 'co_id' | 'sow_id' | null = null
      let sourceId: string | null = null
      let sourceLabel = ''
      if (invoice.milestone_id) {
        const { data: milestone } = await (service as any)
          .from('payment_milestones').select('amount').eq('id', invoice.milestone_id).maybeSingle()
        if (milestone) { cap = Number(milestone.amount); sourceLabel = "this milestone's defined amount" }
        // Milestones are a natural singleton (see POST /api/invoices) —
        // no cumulative sum needed, just the direct cap.
        if (cap != null && finalSubtotal > cap + 0.01) {
          return NextResponse.json({
            error: `Invoice amount (${finalSubtotal.toFixed(2)} before tax) exceeds ${sourceLabel} (${cap.toFixed(2)}).`,
          }, { status: 400 })
        }
      } else if (invoice.co_id) {
        const { data: co } = await (service as any)
          .from('change_orders').select('subtotal').eq('id', invoice.co_id).maybeSingle()
        if (co) { cap = Number(co.subtotal); sourceColumn = 'co_id'; sourceId = invoice.co_id; sourceLabel = "this change order's accepted amount" }
      } else if (invoice.sow_id) {
        const { data: proj } = await (service as any)
          .from('projects').select('contract_value').eq('id', invoice.project_id).maybeSingle()
        if (proj) { cap = Number(proj.contract_value) || 0; sourceColumn = 'sow_id'; sourceId = invoice.sow_id; sourceLabel = "this SOW's contract value" }
      }
      if (cap != null && sourceColumn && sourceId) {
        const { data: others } = await (service as any)
          .from('invoices').select('id, subtotal, amount')
          .eq(sourceColumn, sourceId).neq('status', 'void').neq('id', id)
        const othersTotal = (others || []).reduce((s: number, i: any) => s + Number(i.subtotal ?? i.amount ?? 0), 0)
        if (othersTotal + finalSubtotal > cap + 0.01) {
          const remaining = Math.max(0, cap - othersTotal)
          return NextResponse.json({
            error: `${othersTotal.toFixed(2)} is already invoiced elsewhere against ${sourceLabel.replace('this ', '')} — only ${remaining.toFixed(2)} remains billable (before tax).`,
          }, { status: 400 })
        }
      }
    }

    // Optional itemized breakdown — same footing rule as creation (see
    // POST /api/invoices), checked against the (possibly just-recomputed)
    // SUBTOTAL, not the tax-inclusive grand total — line items are a
    // pre-tax breakdown (same convention change_orders.line_items uses).
    // FIX (re-audit, critical finding): this used to compare against
    // `effectiveAmount` (the grand total) — see POST /api/invoices for the
    // full explanation of why that made itemized + tax-exclusive invoices
    // permanently unsaveable.
    if (cleanLineItems !== undefined) {
      if (cleanLineItems.length > 0) {
        const itemSum = cleanLineItems.reduce((s: number, l: any) => s + l.total, 0)
        if (Math.abs(itemSum - finalSubtotal) > 0.01) {
          return NextResponse.json({
            error: `Line items total ${itemSum.toFixed(2)} does not match invoice subtotal ${finalSubtotal.toFixed(2)}`,
          }, { status: 400 })
        }
      }
      // FIX (section-12 audit): same jsonb-vs-string bug as POST
      // /api/invoices — see the comment there.
      update.line_items = cleanLineItems
    }

    const { error } = await (service as any).from('invoices').update(update).eq('id', id)
    if (error) return NextResponse.json({ error: 'Failed to update invoice' }, { status: 500 })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice update error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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

    // FIX (section-12 audit — feature gap follow-through): a gated
    // invoice stays 'draft' the whole time it's under review, so the
    // status check above didn't stop this route from deleting one out
    // from under an in-flight approval chain — leaving a pending
    // approval_requests row notifying an approver about a document that
    // no longer exists, with nothing to ever clear it. Same
    // cancel-before-delete pattern already used for CO close/withdraw.
    await cancelApprovalRequest(service, {
      documentType: 'invoice', documentId: id, workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: 'Invoice deleted',
    })

    await (service as any).from('invoices').delete().eq('id', id)

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.deleted', entityType: 'invoice',
      entityId: id, entityName: invoice.title,
      // The invoice row is already gone, so the DB trigger can't resolve its
      // project any more — record it explicitly (migration 056).
      projectId: invoice.project_id,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice delete error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
