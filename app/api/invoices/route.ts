export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'

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
        projects(id, name, clients(id, name, company_name))`)
      .eq('workspace_id', session.workspaceId)
      .order('created_at', { ascending: false })

    if (projectId) {
      query = query.eq('project_id', projectId)
    } else if (!canViewAll) {
      const { data: ids } = await (service as any)
        .from('project_members')
        .select('project_id, workspace_members!inner(user_id)')
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

    const body = await request.json()
    const {
      projectId, milestoneId, sowId, coId,
      title, amount, dueDate, paymentInstructions, notes,
      taxRate, taxInclusive, lineItems, poNumber,
    } = body || {}

    if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
    if (!title?.trim()) return NextResponse.json({ error: 'A title is required' }, { status: 400 })
    if (!milestoneId && !sowId && !coId)
      return NextResponse.json({ error: 'An invoice must bill against a milestone, SOW, or change order' }, { status: 400 })
    const numAmount = Number(amount)
    if (!numAmount || numAmount <= 0)
      return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 })

    const service = createServiceClient()

    const { data: project } = await (service as any)
      .from('projects')
      .select('id, name, currency, status, contract_value')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).single()

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Validate the linked source actually belongs to this project/workspace
    // and is in a billable state — an invoice against a still-draft SOW or
    // a not-yet-accepted CO would have nothing behind it to justify billing.
    let coTaxDefaults: { taxRate: number; taxInclusive: boolean; subtotal: number } | null = null
    // FIX (section-12 audit, real bug — flagship finding): milestone.amount
    // and co.subtotal were both already being fetched here and then never
    // referenced again — an agency could bill any figure at all against a
    // milestone or CO with zero validation tying the two together, on a
    // product whose entire premise is preventing exactly this kind of
    // financial drift. Capped below (after tax math resolves finalSubtotal)
    // to whatever the linked source was actually scoped for. Under-billing
    // (partial invoicing) is intentionally still allowed — only billing
    // MORE than the source's own defined value is blocked.
    //
    // FIX (section-12 fix round, flagship finding): the per-invoice cap
    // above was necessary but not sufficient — nothing ever stopped
    // creating a SECOND (or third) invoice against the same SOW or CO,
    // each individually under the cap, but together billing the client
    // twice for the same signed scope. A milestone can't hit this because
    // it's a natural singleton (blocked from re-selection the moment it's
    // 'invoiced' — see the milestone branch below), but a SOW/CO has no
    // such lock. sourceCap/sourceInvoicedElsewhere below make the cap
    // CUMULATIVE: the sum of every non-void invoice already issued against
    // this exact source, plus this new one, may never exceed the source's
    // own value. sowId had no cap at all before this fix — a SOW-linked
    // invoice's `amount` was never even checked against project.contract_value.
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
      // FIX (section-12 audit, real bug): this only blocked `status ===
      // 'paid'` — a milestone already sitting at 'invoiced' (a sent
      // invoice already exists against it, per sync_milestone_from_
      // invoice()) sailed straight through, and the "Bill against" picker
      // (components/invoices/BillingTab.tsx) offered that same milestone
      // right back to the agency. No bypass needed: an agency user who
      // forgot they'd already billed this milestone could pick it again
      // from the normal dropdown and send the client a second, duplicate
      // invoice for the same deliverable. 'pending'/'overdue' remain
      // billable (a voided invoice reverts its milestone to 'pending' —
      // see void/route.ts — so re-invoicing after a void still works).
      if (milestone.status === 'paid' || milestone.status === 'invoiced')
        return NextResponse.json({
          error: milestone.status === 'paid'
            ? 'This milestone is already marked paid'
            : 'This milestone already has an invoice against it — void the existing one first if you need to re-invoice it',
        }, { status: 400 })
      milestoneCap = Number(milestone.amount)
      sourceKind = 'milestone'; sourceId = milestoneId
    }
    if (sowId) {
      // FIX (section-12 fix round, flagship finding): contract_value added
      // to the select — this branch never fetched it before, so a
      // SOW-linked invoice had no amount cap at all, not even a
      // single-invoice one (see the comment on milestoneCap/coSubtotalCap
      // above).
      const { data: sow } = await (service as any)
        .from('sow_documents').select('id, project_id, status')
        .eq('id', sowId).eq('project_id', projectId).single()
      if (!sow) return NextResponse.json({ error: 'SOW not found on this project' }, { status: 404 })
      if (sow.status !== 'signed')
        return NextResponse.json({ error: 'Only a signed SOW can be invoiced against' }, { status: 400 })
      sowCap = Number(project.contract_value) || 0
      sourceKind = 'sow'; sourceId = sowId
    }
    if (coId) {
      const { data: co } = await (service as any)
        .from('change_orders').select('id, project_id, status, subtotal, tax_rate, tax_inclusive')
        .eq('id', coId).eq('project_id', projectId).single()
      if (!co) return NextResponse.json({ error: 'Change order not found on this project' }, { status: 404 })
      if (co.status !== 'accepted')
        return NextResponse.json({ error: 'Only an accepted change order can be invoiced against' }, { status: 400 })
      // FIX (doc-completeness audit, finding #2): carry the CO's own tax
      // terms into the invoice by default, rather than silently dropping
      // them — an accepted CO that had 8% tax on it shouldn't turn into
      // a plain untaxed invoice line unless the agency explicitly
      // overrides taxRate/taxInclusive in the request body.
      if (taxRate === undefined) coTaxDefaults = { taxRate: co.tax_rate, taxInclusive: co.tax_inclusive, subtotal: co.subtotal }
      coSubtotalCap = Number(co.subtotal)
      sourceKind = 'co'; sourceId = coId
    }

    // Optional itemized breakdown (migration 017), computed before the
    // tax math below since it now feeds into it — see the taxInclusive
    // fix just underneath.
    let cleanLineItems: Array<{ description: string; quantity: number; rate: number; total: number }> = []
    if (Array.isArray(lineItems) && lineItems.length > 0) {
      cleanLineItems = lineItems.map((l: any) => ({
        description: String(l.description || '').trim().slice(0, 500),
        quantity:    Number(l.quantity) || 0,
        rate:        Number(l.rate) || 0,
        total:       Number(l.total) || 0,
      })).filter(l => l.description)
    }
    const isItemized = cleanLineItems.length > 0

    const finalTaxRate = taxRate !== undefined ? Number(taxRate) || 0 : (coTaxDefaults?.taxRate || 0)
    // FIX (section-12 audit): an itemized invoice's `amount` is DERIVED
    // from summing the line items (see BillingTab.tsx) — a pre-tax figure
    // by construction, since no per-line tax is ever applied. That's
    // inherently "before tax", regardless of what the taxInclusive field
    // says — but this used to trust taxInclusive verbatim even when
    // itemized, and the UI's own default for that field is 'inclusive'.
    // Fed a pre-tax sum under a tax-INCLUSIVE assumption, the math below
    // divides it by (1 + rate) to back out a *smaller* subtotal that the
    // line items can never foot to — making the (itemized + nonzero tax +
    // default tax-inclusive) combination permanently uncreatable, the
    // exact mirror of the itemized + tax-EXCLUSIVE bug already fixed
    // right below. Force exclusive whenever line items are present; it's
    // not a preference to trust from the client, it's a fact about how
    // itemized amounts are computed.
    const finalTaxInclusive = isItemized
      ? false
      : (taxInclusive !== undefined ? !!taxInclusive : !!coTaxDefaults?.taxInclusive)
    // `amount` in the DB is always the grand total the client owes.
    // The create form lets the agency enter either figure: if the entered
    // amount is tax-inclusive, it already *is* the grand total and we
    // back out the subtotal for display; if it's "before tax", the
    // entered amount is the subtotal and we need to gross it up.
    let finalAmount = numAmount
    let finalSubtotal = numAmount
    if (finalTaxRate > 0) {
      if (finalTaxInclusive) {
        finalSubtotal = numAmount / (1 + finalTaxRate / 100)
      } else {
        finalSubtotal = numAmount
        finalAmount   = numAmount * (1 + finalTaxRate / 100)
      }
    } else if (coTaxDefaults) {
      finalSubtotal = coTaxDefaults.subtotal ?? numAmount
    }

    // FIX (section-12 audit, flagship finding continued): the actual cap
    // check — compared pre-tax to pre-tax, since tax is something the
    // agency adds on top at invoicing time and was never part of what the
    // milestone/CO was originally scoped or accepted for.
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

    // FIX (section-12 fix round, flagship finding): CUMULATIVE cap — a
    // single-invoice cap (above) doesn't stop a second or third invoice
    // against the same SOW/CO, each individually under the cap but
    // together over-billing the client for the same signed scope. Sum
    // every non-void invoice already issued against this exact source
    // (milestone is excluded — it's already a hard singleton via the
    // status check above, so there's never a prior invoice to sum) and
    // make sure this new one doesn't push the total past the source's cap.
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

    // Soft rule enforced in code, not a DB constraint (matches the
    // column's documented contract): if the agency supplies line items,
    // they must foot to the invoice subtotal — otherwise the PDF would
    // show an itemized table whose rows don't sum to the number the
    // client is actually being asked to pay, which is worse than not
    // itemizing at all.
    if (isItemized) {
      const itemSum = cleanLineItems.reduce((s, l) => s + l.total, 0)
      // FIX (re-audit, critical finding): this compared against
      // `finalAmount` (the tax-inclusive grand total) instead of
      // `finalSubtotal` — but line items are a pre-tax breakdown (the same
      // convention change_orders.line_items already uses: subtotal is
      // derived from summing items, tax is applied once on top). Any
      // itemized invoice with a non-zero, tax-EXCLUSIVE rate would always
      // fail this check by exactly the tax amount, making that combination
      // completely uncreatable. Tax-inclusive happened to work by
      // coincidence, since finalAmount === finalSubtotal in that case.
      if (Math.abs(itemSum - finalSubtotal) > 0.01) {
        return NextResponse.json({
          error: `Line items total ${itemSum.toFixed(2)} does not match invoice subtotal ${finalSubtotal.toFixed(2)}`,
        }, { status: 400 })
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
        // FIX (section-12 audit): line_items is jsonb (migration 017) —
        // JSON.stringify(...) here wrote a JSON *string* into the column
        // instead of a native array, the exact same bug already found and
        // fixed once for change_orders.line_items (see app/api/co/route.ts).
        // Masked today only because both PDF-render paths defensively
        // unwrap `typeof === 'string' ? JSON.parse(...) : ...` — but the
        // column stops matching its own documented contract, and any
        // future direct consumer without that unwrap breaks. Write the
        // array directly; PostgREST/Supabase serializes it as jsonb on
        // its own.
        line_items:    cleanLineItems,
        currency:      project.currency || 'USD',
        due_date:      dueDate || null,
        // FIX (section-12 audit — feature gap): po_number (migration 011)
        // was fully modeled and rendered in the send-email PDF, the
        // standalone PDF download, and the client portal view — but had no
        // write path anywhere. Every invoice this product ever generated
        // had a blank PO-number line by construction. Cap matches the
        // column's own documented purpose (a short client-issued
        // reference), not an arbitrary limit.
        po_number:     poNumber?.trim().slice(0, 100) || null,
        payment_instructions: sanitizeRichTextOrNull(paymentInstructions),
        notes:         notes?.trim() || null,
        created_by:    session.id,
      })
      .select('id, title, amount, currency, status')
      .single()

    if (error) {
      console.error('Invoice create error:', error)
      return NextResponse.json({ error: 'Failed to create invoice' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.created', entityType: 'invoice',
      entityId: invoice.id, entityName: invoice.title,
      metadata: { amount: numAmount, project_id: projectId },
    })

    return NextResponse.json({ ok: true, invoice })
  } catch (err) {
    console.error('Invoice create error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
