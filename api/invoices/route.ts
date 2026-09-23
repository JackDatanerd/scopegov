export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'
import { computeInvoiceTotals, parseDateOnly } from '@/lib/documents/invoice-totals'
import { computeContractPosition, baseContractValue } from '@/lib/reports/contract-position'

// GET /api/invoices?projectId=&status= — workspace-wide (or project-scoped) list
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_FINANCIALS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId')
    const status    = searchParams.get('status')

    const service = createServiceClient()

    // FIX (audit round 3): this list had no project-membership filter at
    // all — every invoice in the workspace was returned regardless of the
    // caller's assigned projects, same gap fixed on /api/projects and
    // /api/search (see lib/utils/project-access.ts).
    const canViewAll = hasPermission(session, 'VIEW_ALL_PROJECTS')
    if (projectId && !(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // FIX (section-12 fix round — feature gap): disputed_at was never
    // selected here, so a client's portal dispute (api/portal/invoice/
    // [token]/dispute) had no way to surface anywhere in the agency's own
    // UI beyond the one-time notification it fires. See invoices/page.tsx
    // and BillingTab.tsx for the corresponding display-side fix.
    let query = (service as any)
      .from('invoices')
      .select(`id, project_id, milestone_id, sow_id, co_id, invoice_number, title,
        amount, amount_paid, currency, status, due_date, sent_at, paid_at, voided_at,
        disputed_at, created_at, updated_at,
        projects!inner(id, name, deleted_at, clients(id, name, company_name))`)
      .eq('workspace_id', session.workspaceId)
      // Invoices of a soft-deleted (trashed) project are not part of the live ledger.
      .is('projects.deleted_at', null)
      .order('created_at', { ascending: false })

    if (projectId) {
      query = query.eq('project_id', projectId)
    } else if (!canViewAll) {
      // FIX (fix round, section-11/12 finding): same workspace-scoping gap
      // as /api/approvals — filtered on workspace_members.user_id alone,
      // with no workspace_id scope, so it pulled in project ids from every
      // workspace the viewer belongs to, not just this one. Mirrors
      // canReadProject's own join pattern (lib/utils/project-access.ts).
      const { data: ids } = await (service as any)
        .from('project_members')
        .select('project_id, projects!inner(workspace_id), workspace_members!inner(user_id)')
        .eq('projects.workspace_id', session.workspaceId)
        .eq('workspace_members.user_id', session.id)
      query = query.in('project_id', (ids || []).map((r: any) => r.project_id))
    }
    if (status) query = query.eq('status', status)

    const { data: invoices, error } = await query.limit(500)
    if (error) {
      console.error('Invoices list error:', error)
      return NextResponse.json({ error: 'Failed to load invoices' }, { status: 500 })
    }

    return NextResponse.json({ invoices: invoices || [] })
  } catch (err) {
    // FIX (section-12 fix round): raw exception messages were returned
    // straight to the client here — same info-disclosure pattern already
    // fixed on the invoice PDF/portal routes, just never applied to this
    // one. Log server-side only.
    console.error('Invoices list error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/invoices — create a draft invoice against a milestone, signed SOW, or accepted CO
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const {
      projectId, milestoneId, sowId, coId,
      title, amount, dueDate, paymentInstructions, notes,
      taxRate, taxInclusive, lineItems, poNumber,
    } = body

    // FIX (section-12 audit, pass 2): every text field was used as if it were a
    // string (`title?.trim()`, `poNumber?.trim()`, `notes?.trim()`) — a number or
    // object in the body threw a TypeError and came back as an opaque 500.
    if (typeof projectId !== 'string' || !projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
    if (typeof title !== 'string' || !title.trim()) return NextResponse.json({ error: 'A title is required' }, { status: 400 })
    if (title.trim().length > 200) return NextResponse.json({ error: 'Title must be under 200 characters' }, { status: 400 })
    if (poNumber != null && typeof poNumber !== 'string') return NextResponse.json({ error: 'PO number must be text' }, { status: 400 })
    if (notes != null && typeof notes !== 'string') return NextResponse.json({ error: 'Notes must be text' }, { status: 400 })
    if (typeof notes === 'string' && notes.length > 5000) return NextResponse.json({ error: 'Notes must be under 5,000 characters' }, { status: 400 })
    if (!milestoneId && !sowId && !coId)
      return NextResponse.json({ error: 'An invoice must bill against a milestone, SOW, or change order' }, { status: 400 })

    // An unparseable due date used to reach the database and come back as a 500.
    let due: string | null = null
    if (dueDate !== undefined && dueDate !== null && dueDate !== '') {
      due = parseDateOnly(dueDate)
      if (!due) return NextResponse.json({ error: 'Due date must be a valid date' }, { status: 400 })
    }

    const service = createServiceClient()

    // Soft-deleted projects are excluded, same as the SOW/CO routes: an invoice
    // could be created (and later sent) for a project sitting in the trash.
    const { data: project } = await (service as any)
      .from('projects')
      .select('id, name, currency, status, contract_value, type, retainer_duration_months')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).is('deleted_at', null).single()

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Validate the linked source actually belongs to this project/workspace and
    // is in a billable state — an invoice against a still-draft SOW or a
    // not-yet-accepted CO would have nothing behind it to justify billing.
    //
    // Each source carries a cap: an invoice may bill LESS than the source's own
    // value (partial invoicing is supported) but never more, and the sum of every
    // non-void invoice against a SOW/CO may never exceed it.
    let coTaxDefaults: { taxRate: number; taxInclusive: boolean } | null = null
    let milestoneCap: number | null = null
    let coSubtotalCap: number | null = null
    let sowCap: number | null = null
    let sourceKind: 'milestone' | 'sow' | 'co' | null = null
    let sourceId: string | null = null
    if (milestoneId) {
      const { data: milestone } = await (service as any)
        .from('payment_milestones').select('id, project_id, amount, status')
        .eq('id', milestoneId).eq('project_id', projectId).single()
      if (!milestone) return NextResponse.json({ error: 'Milestone not found on this project' }, { status: 404 })
      // 'pending'/'overdue' remain billable (a voided invoice reverts its milestone
      // to 'pending', so re-invoicing after a void still works).
      if (milestone.status === 'paid' || milestone.status === 'invoiced')
        return NextResponse.json({
          error: milestone.status === 'paid'
            ? 'This milestone is already marked paid'
            : 'This milestone already has an invoice against it — void the existing one first if you need to re-invoice it',
        }, { status: 400 })
      // FIX (section-12 audit, pass 2): the status check above only sees SENT
      // invoices (the milestone flips to 'invoiced' on send). Two DRAFTS against
      // the same milestone were both creatable — and both sendable, billing the
      // client twice for the same deliverable. Any live (non-void) invoice counts.
      const { data: liveForMilestone } = await (service as any)
        .from('invoices').select('id, status').eq('milestone_id', milestoneId).neq('status', 'void').limit(1)
      if (liveForMilestone && liveForMilestone.length > 0)
        return NextResponse.json({
          error: 'This milestone already has an invoice (a draft counts) — edit or delete that one, or void it, before creating another.',
        }, { status: 409 })
      milestoneCap = Number(milestone.amount)
      sourceKind = 'milestone'; sourceId = milestoneId
    }
    if (sowId) {
      const { data: sow } = await (service as any)
        .from('sow_documents').select('id, project_id, status')
        .eq('id', sowId).eq('project_id', projectId).single()
      if (!sow) return NextResponse.json({ error: 'SOW not found on this project' }, { status: 404 })
      if (sow.status !== 'signed')
        return NextResponse.json({ error: 'Only a signed SOW can be invoiced against' }, { status: 400 })
      // FIX (re-audit, section-12 finding): project.contract_value is the
      // MONTHLY rate for a retainer project (baseContractValue() is the
      // helper the rest of the app already uses to turn that into the
      // real contracted total — see lib/reports/contract-position.ts).
      // This cap used the raw column directly, so billing a retainer
      // project against its signed SOW for anything beyond one month's
      // rate was refused as "exceeding the SOW's contract value" — a cap
      // that was really just one month of a multi-month contract.
      sowCap = baseContractValue(project)
      sourceKind = 'sow'; sourceId = sowId
    }
    if (coId) {
      const { data: co } = await (service as any)
        .from('change_orders').select('id, project_id, status, subtotal, tax_rate, tax_inclusive')
        .eq('id', coId).eq('project_id', projectId).single()
      if (!co) return NextResponse.json({ error: 'Change order not found on this project' }, { status: 404 })
      if (co.status !== 'accepted')
        return NextResponse.json({ error: 'Only an accepted change order can be invoiced against' }, { status: 400 })
      // Carry the CO's own tax terms into the invoice by default, rather than
      // silently dropping them, unless the request overrides taxRate.
      if (taxRate === undefined) coTaxDefaults = { taxRate: Number(co.tax_rate) || 0, taxInclusive: !!co.tax_inclusive }
      coSubtotalCap = Number(co.subtotal)
      sourceKind = 'co'; sourceId = coId
    }

    // One validated, rounding implementation (lib/documents/invoice-totals.ts).
    const computed = computeInvoiceTotals({
      entered: amount, taxRate, taxInclusive, lineItems, inherited: coTaxDefaults,
    })
    if (!computed.ok) return NextResponse.json({ error: computed.error }, { status: 400 })
    const { amount: finalAmount, subtotal: finalSubtotal, taxRate: finalTaxRate, taxInclusive: finalTaxInclusive, lineItems: cleanLineItems } = computed.totals

    // Cap check — pre-tax against pre-tax, since tax is added at invoicing time and
    // was never part of what the milestone/CO was scoped or accepted for.
    if (milestoneCap != null && finalSubtotal > milestoneCap + 0.01) {
      return NextResponse.json({
        error: `Invoice amount (${finalSubtotal.toFixed(2)} before tax) exceeds this milestone's defined amount (${milestoneCap.toFixed(2)}). Adjust the milestone first if its value has genuinely changed.`,
      }, { status: 400 })
    }
    if (coSubtotalCap != null && finalSubtotal > coSubtotalCap + 0.01) {
      return NextResponse.json({
        error: `Invoice amount (${finalSubtotal.toFixed(2)} before tax) exceeds this change order's accepted amount (${coSubtotalCap.toFixed(2)}).`,
      }, { status: 400 })
    }
    if (sowCap != null && finalSubtotal > sowCap + 0.01) {
      return NextResponse.json({
        error: `Invoice amount (${finalSubtotal.toFixed(2)} before tax) exceeds this SOW's contract value (${sowCap.toFixed(2)}).`,
      }, { status: 400 })
    }

    // CUMULATIVE cap for a SOW/CO (a milestone is a singleton — see above).
    if (sourceKind === 'sow' || sourceKind === 'co') {
      const cap = sourceKind === 'sow' ? sowCap : coSubtotalCap
      if (cap != null) {
        const sourceColumn = sourceKind === 'sow' ? 'sow_id' : 'co_id'
        const { data: priorInvoices } = await (service as any)
          .from('invoices')
          .select('subtotal, amount')
          .eq(sourceColumn, sourceId)
          .neq('status', 'void')
        const alreadyInvoiced = (priorInvoices || [])
          .reduce((s: number, i: any) => s + Number(i.subtotal ?? i.amount ?? 0), 0)
        if (alreadyInvoiced + finalSubtotal > cap + 0.01) {
          const remaining = Math.max(0, cap - alreadyInvoiced)
          return NextResponse.json({
            error: `This ${sourceKind === 'sow' ? 'SOW' : 'change order'} has ${alreadyInvoiced.toFixed(2)} already invoiced against it — only ${remaining.toFixed(2)} remains billable (before tax).`,
          }, { status: 400 })
        }
      }
    }

    // FIX (section-12 audit, pass 2 — feature gap): every cap above is PER SOURCE.
    // Nothing looked at the project as a whole, so invoicing every milestone (which
    // together are the contract value) AND THEN a SOW invoice for the full contract
    // value billed the same money twice, each invoice individually under its own cap.
    // A project-level check against contracted value (base + amendments — the same
    // definition the Contract-position block uses) catches it. It is a confirmation,
    // not a hard block: legitimate billing outside the contracted value exists
    // (reimbursables, T&M overage), so the caller can acknowledge and proceed.
    if (body.acknowledgeOverContract !== true) {
      const position = await computeContractPosition(service, projectId)
      if (position && position.contractedValue > 0) {
        const { data: drafts } = await (service as any)
          .from('invoices').select('subtotal, amount').eq('project_id', projectId).eq('status', 'draft')
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

    const { data: invoice, error } = await (service as any)
      .from('invoices')
      .insert({
        workspace_id:  session.workspaceId,
        project_id:    projectId,
        milestone_id:  milestoneId || null,
        sow_id:        sowId || null,
        co_id:         coId || null,
        title:         title.trim(),
        amount:        finalAmount,
        subtotal:      finalSubtotal,
        tax_rate:      finalTaxRate,
        tax_inclusive: finalTaxInclusive,
        // line_items is jsonb (migration 017) — write the array directly, never a
        // JSON string. Totals are quantity × rate, computed server-side.
        line_items:    cleanLineItems,
        currency:      project.currency || 'USD',
        due_date:      due,
        // po_number (migration 011): a short client-issued reference.
        po_number:     poNumber?.trim().slice(0, 100) || null,
        payment_instructions: sanitizeRichTextOrNull(paymentInstructions),
        notes:         notes?.trim() || null,
        created_by:    session.id,
      })
      .select('id, title, amount, currency, status')
      .single()

    if (error) {
      // The one-live-invoice-per-milestone index (migration 069) backstops the
      // check above against two simultaneous creates.
      if ((error as any).code === '23505')
        return NextResponse.json({ error: 'This milestone already has an invoice — refresh and check its billing tab.' }, { status: 409 })
      console.error('Invoice create error:', error)
      return NextResponse.json({ error: 'Failed to create invoice' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.created', entityType: 'invoice',
      entityId: invoice.id, entityName: invoice.title,
      metadata: { amount: finalAmount, subtotal: finalSubtotal, project_id: projectId },
    })

    return NextResponse.json({ ok: true, invoice })
  } catch (err) {
    console.error('Invoice create error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
