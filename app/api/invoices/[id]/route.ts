export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'
import { computeInvoiceTotals, enteredAmountOf, parseDateOnly } from '@/lib/documents/invoice-totals'
import { baseContractValue, computeContractPosition } from '@/lib/reports/contract-position'
import { getPendingApprovalForDocument, cancelApprovalRequest } from '@/lib/approvals/engine'
import { isSendClaimLive } from '@/lib/approvals/send-claim'

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

    // FIX (independent pass 3): `select('*')` above ships the raw, unauthenticated
    // client-portal `token` to anyone who merely holds VIEW_FINANCIALS — a much
    // broader grant than the ability to actually send/manage invoices, and often a
    // read-only reporting role. Same over-exposure the SOW detail route (and now the
    // project page's own invoices fetch) was already fixed for; redact it here too
    // unless the caller can actually act as the sender.
    if (!hasPermission(session, 'SEND_INVOICES')) invoice.token = null

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
    // A gated invoice stays at status:'draft' the entire time it's under review
    // (same pattern as SOW/CO): without this lock an approver could be reviewing
    // one amount while the requester quietly changes it underneath them.
    const activeApproval = await getPendingApprovalForDocument(service, 'invoice', id)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    // FIX (section-11 audit): an invoice that finished approval but whose auto-send failed on a
    // stale due date had no way out — the send refuses a past due date (see send-invoice.ts), but
    // this lock refused everything, including the date, unless the approval was cancelled first
    // (throwing it away and starting over). The date isn't something approvers signed off on (the
    // amount, title and payment instructions are, and those stay locked); let it move on its own
    // so Retry can actually succeed.
    if (activeApproval) {
      const approvedNotSent = activeApproval.status === 'approved' && !!activeApproval.send_failed_at && !activeApproval.sending_started_at
      const onlyDueDate = Object.keys(body).length > 0 && Object.keys(body).every(k => k === 'dueDate')
      if (!(approvedNotSent && onlyDueDate)) {
        return NextResponse.json(
          { error: approvedNotSent
              ? 'This invoice was approved but could not be sent. You can change its due date and retry the send from Approvals — to edit anything else, cancel that request first.'
              : 'This invoice has a pending approval request — cancel it before editing.' },
          { status: 409 }
        )
      }
    }

    const update: Record<string, any> = { updated_at: new Date().toISOString() }

    // FIX (section-12 audit, pass 2): none of these fields were type-checked — a
    // number/object where text was expected threw a TypeError (opaque 500); an
    // empty title was accepted (POST requires one); an invalid due date reached the
    // database; notes were stored unsanitised and unbounded.
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim())
        return NextResponse.json({ error: 'A title is required' }, { status: 400 })
      if (body.title.trim().length > 200)
        return NextResponse.json({ error: 'Title must be under 200 characters' }, { status: 400 })
      update.title = body.title.trim()
    }
    if (body.dueDate !== undefined) {
      if (body.dueDate === null || body.dueDate === '') update.due_date = null
      else {
        const due = parseDateOnly(body.dueDate)
        if (!due) return NextResponse.json({ error: 'Due date must be a valid date' }, { status: 400 })
        update.due_date = due
      }
    }
    if (body.poNumber !== undefined) {
      if (body.poNumber !== null && typeof body.poNumber !== 'string')
        return NextResponse.json({ error: 'PO number must be text' }, { status: 400 })
      update.po_number = body.poNumber?.trim().slice(0, 100) || null
    }
    if (body.paymentInstructions !== undefined) update.payment_instructions = sanitizeRichTextOrNull(body.paymentInstructions)
    if (body.notes !== undefined) {
      if (body.notes !== null && typeof body.notes !== 'string')
        return NextResponse.json({ error: 'Notes must be text' }, { status: 400 })
      if (typeof body.notes === 'string' && body.notes.length > 5000)
        return NextResponse.json({ error: 'Notes must be under 5,000 characters' }, { status: 400 })
      update.notes = body.notes?.trim() || null
    }

    // Money. Recomputed whenever the amount, tax or line items change.
    const existingLineItems = typeof invoice.line_items === 'string'
      ? JSON.parse(invoice.line_items || '[]') : (invoice.line_items || [])
    const touchesMoney = body.amount !== undefined || body.taxRate !== undefined
      || body.taxInclusive !== undefined || body.lineItems !== undefined
    let finalSubtotal = invoice.subtotal != null ? Number(invoice.subtotal) : Number(invoice.amount)
    // Populated inside the touchesMoney block below when the source is a SOW/CO;
    // stay null otherwise so update_invoice_capped (migration 096) skips its
    // cumulative-cap check entirely and just does the plain CAS'd update.
    let cumulativeCap: number | null = null
    let cumulativeSourceColumn: 'co_id' | 'sow_id' | null = null
    let cumulativeSourceId: string | null = null

    if (touchesMoney) {
      const lineItemsInput = body.lineItems !== undefined ? body.lineItems : existingLineItems
      // FIX (section-12 audit, pass 2): when `amount` was omitted this fell back to
      // the STORED amount — the gross total — and then, for a tax-exclusive invoice,
      // grossed it up AGAIN (tax on tax). The figure to fall back to is the one the
      // agency originally typed: the net when tax is exclusive, the gross when inclusive.
      const entered = body.amount !== undefined ? body.amount : enteredAmountOf(invoice)
      const computed = computeInvoiceTotals({
        entered,
        taxRate: body.taxRate !== undefined ? body.taxRate : Number(invoice.tax_rate || 0),
        taxInclusive: body.taxInclusive !== undefined ? body.taxInclusive : !!invoice.tax_inclusive,
        lineItems: lineItemsInput,
      })
      if (!computed.ok) return NextResponse.json({ error: computed.error }, { status: 400 })
      const t = computed.totals
      finalSubtotal = t.subtotal
      update.amount        = t.amount
      update.subtotal      = t.subtotal
      update.tax_rate      = t.taxRate
      update.tax_inclusive = t.taxInclusive
      if (body.lineItems !== undefined || t.isItemized) update.line_items = t.lineItems

      // Re-check the caps: an edit must not let the amount drift past what the
      // linked milestone/CO/SOW was scoped for, counting everything ELSE already
      // billed against the same source (this invoice's own row excluded).
      //
      // FIX (independent audit — read-then-write race): the cumulative SOW/CO
      // check used to read every OTHER invoice, sum it, and compare right here —
      // then write in a completely separate later step. Two edits (or a create
      // and an edit) against the SAME sow_id/co_id close enough together could
      // each read the same "othersTotal" and both pass, together landing past
      // the cap. The actual check-then-write for the SOW/CO case now happens
      // inside update_invoice_capped (migration 096), which locks the sow/co row
      // before recomputing the sum, so a second concurrent caller can't start
      // its own sum until this one has committed or rolled back. Only the
      // milestone case (a fixed, non-cumulative comparison — no race to close)
      // still checks and errors out directly here.
      if (invoice.milestone_id) {
        const { data: milestone } = await (service as any)
          .from('payment_milestones').select('amount').eq('id', invoice.milestone_id).maybeSingle()
        if (milestone && finalSubtotal > Number(milestone.amount) + 0.01) {
          return NextResponse.json({
            error: `Invoice amount (${finalSubtotal.toFixed(2)} before tax) exceeds this milestone's defined amount (${Number(milestone.amount).toFixed(2)}).`,
          }, { status: 400 })
        }
      } else if (invoice.co_id) {
        const { data: co } = await (service as any)
          .from('change_orders').select('subtotal').eq('id', invoice.co_id).maybeSingle()
        if (co) { cumulativeCap = Number(co.subtotal); cumulativeSourceColumn = 'co_id'; cumulativeSourceId = invoice.co_id }
      } else if (invoice.sow_id) {
        const { data: proj } = await (service as any)
          .from('projects').select('contract_value, type, retainer_duration_months').eq('id', invoice.project_id).maybeSingle()
        // FIX (re-audit, section-12 finding): same raw-contract_value bug as
        // POST /api/invoices — see baseContractValue()'s own comment for why
        // a retainer project's monthly rate isn't the SOW's real cap.
        // (Round 3: an open-ended retainer — type retainer, no term — has no fixed total to cap against; see the
        // same note in POST /api/invoices.)
        if (proj) {
          const openEndedRetainer = proj.type === 'retainer' && !((proj.retainer_duration_months || 0) > 0)
          cumulativeCap = openEndedRetainer ? null : baseContractValue(proj)
          cumulativeSourceColumn = 'sow_id'; cumulativeSourceId = invoice.sow_id
        }
      }

      // FIX (section-12 audit, independent pass 4 — feature gap): POST /api/invoices
      // has a project-level check against contracted value (base + amendments) on top
      // of every per-source cap above, specifically because the per-source caps alone
      // let an agency double-bill the same contract value across DIFFERENT sources
      // (every milestone invoiced, then a SOW invoice for the full value too — see
      // that route's own comment). PATCH re-checks every per-source cap on an edit but
      // never re-ran this one — a draft created for a small amount (well under
      // contract, so no warning fired at creation) could be edited upward past the
      // project's contracted value with the acknowledgeOverContract confirmation never
      // triggering at all. Same confirmation-not-hard-block shape as POST: the
      // draftTotal sum excludes THIS invoice's own (pre-edit) row, since finalSubtotal
      // is the new amount actually being tested.
      if (body.acknowledgeOverContract !== true) {
        const position = await computeContractPosition(service, invoice.project_id)
        if (position && position.contractedValue > 0) {
          const { data: drafts } = await (service as any)
            .from('invoices').select('subtotal, amount').eq('project_id', invoice.project_id).eq('status', 'draft').neq('id', id)
          const draftTotal = (drafts || []).reduce((s: number, i: any) => s + Number(i.subtotal ?? i.amount ?? 0), 0)
          const projected = position.invoicedToDate + draftTotal + finalSubtotal
          if (projected > position.contractedValue + 0.01) {
            return NextResponse.json({
              error: `This would bring the total invoiced on this project to ${projected.toFixed(2)} (before tax, drafts included) — more than its contracted value of ${position.contractedValue.toFixed(2)}.`,
              code: 'over_contract',
              contractedValue: position.contractedValue,
              projectedInvoiced: projected,
            }, { status: 409 })
          }
        }
      }
    }

    // FIX (section-12 audit, pass 2): the write was `.eq('id', id)` with no status
    // guard — a send (including the approval chain's auto-send) landing between the
    // read above and this write let an edit change a SENT, numbered invoice. Now
    // done inside update_invoice_capped (migration 096), still CAS'd on
    // status='draft', with the SOW/CO cumulative-cap check (when applicable)
    // taken under the same lock rather than as a separate, racy earlier step.
    const { data: patched, error: rpcErr } = await (service as any).rpc('update_invoice_capped', {
      p_invoice_id:   id,
      p_workspace_id: session.workspaceId,
      p_source_column: cumulativeSourceColumn,
      p_source_id:     cumulativeSourceColumn ? cumulativeSourceId : null,
      p_cap:           cumulativeCap,
      p_new_subtotal:  finalSubtotal,
      p_update:        update,
    })
    if (rpcErr) {
      console.error('Invoice update error:', rpcErr)
      return NextResponse.json({ error: 'Failed to update invoice' }, { status: 500 })
    }
    if (!patched?.ok) {
      if (patched?.code === 'over_cap') {
        const already = Number(patched.already_invoiced) || 0
        const remaining = Math.max(0, (cumulativeCap ?? 0) - already)
        const label = cumulativeSourceColumn === 'co_id' ? "this change order's accepted amount" : "this SOW's contract value"
        return NextResponse.json({
          error: `${already.toFixed(2)} is already invoiced elsewhere against ${label.replace('this ', '')} — only ${remaining.toFixed(2)} remains billable (before tax).`,
        }, { status: 400 })
      }
      return NextResponse.json({ error: 'This invoice was just sent or changed — refresh and try again.' }, { status: 409 })
    }

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

    // The last approval step just cleared and the send is running: deleting now
    // would race a document that is about to go out.
    const active = await getPendingApprovalForDocument(service, 'invoice', id)
    if (active?.status === 'pending' && isSendClaimLive(active.sending_started_at))
      return NextResponse.json({ error: 'This invoice was just approved and is being sent — refresh in a moment.' }, { status: 409 })

    // A gated invoice stays 'draft' the whole time it's under review, so the status
    // check above didn't stop a delete out from under an in-flight approval chain
    // (or an approved-but-unsent one). Cancel first, same as CO close/withdraw.
    await cancelApprovalRequest(service, {
      documentType: 'invoice', documentId: id, workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: 'Invoice deleted',
    })

    // FIX (section-12 audit, pass 2): `.eq('id', id)` alone — a send landing between
    // the status read above and this delete would hard-delete an invoice that had
    // just been numbered and emailed to the client. Guard the write on 'draft'.
    const { data: deleted, error: delErr } = await (service as any)
      .from('invoices').delete().eq('id', id).eq('status', 'draft').select('id')
    if (delErr) {
      console.error('Invoice delete error:', delErr)
      return NextResponse.json({ error: 'Failed to delete invoice' }, { status: 500 })
    }
    if (!deleted || deleted.length === 0)
      return NextResponse.json({ error: 'This invoice was just sent, so it can no longer be deleted — void it instead.' }, { status: 409 })

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
