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

    let query = (service as any)
      .from('invoices')
      .select(`id, project_id, milestone_id, sow_id, co_id, invoice_number, title,
        amount, amount_paid, currency, status, due_date, sent_at, paid_at, voided_at,
        created_at, updated_at,
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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
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
      taxRate, taxInclusive, lineItems,
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
      .select('id, name, currency, status')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).single()

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Validate the linked source actually belongs to this project/workspace
    // and is in a billable state — an invoice against a still-draft SOW or
    // a not-yet-accepted CO would have nothing behind it to justify billing.
    let coTaxDefaults: { taxRate: number; taxInclusive: boolean; subtotal: number } | null = null
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
    }
    if (sowId) {
      const { data: sow } = await (service as any)
        .from('sow_documents').select('id, project_id, status')
        .eq('id', sowId).eq('project_id', projectId).single()
      if (!sow) return NextResponse.json({ error: 'SOW not found on this project' }, { status: 404 })
      if (sow.status !== 'signed')
        return NextResponse.json({ error: 'Only a signed SOW can be invoiced against' }, { status: 400 })
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
    }

    const finalTaxRate      = taxRate !== undefined ? Number(taxRate) || 0 : (coTaxDefaults?.taxRate || 0)
    const finalTaxInclusive = taxInclusive !== undefined ? !!taxInclusive : !!coTaxDefaults?.taxInclusive
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

    // Optional itemized breakdown (migration 017). Soft rule enforced in
    // code, not a DB constraint (matches the column's documented contract):
    // if the agency supplies line items, they must foot to the invoice
    // total — otherwise the PDF would show an itemized table whose rows
    // don't sum to the number the client is actually being asked to pay,
    // which is worse than not itemizing at all.
    let cleanLineItems: Array<{ description: string; quantity: number; rate: number; total: number }> = []
    if (Array.isArray(lineItems) && lineItems.length > 0) {
      cleanLineItems = lineItems.map((l: any) => ({
        description: String(l.description || '').trim().slice(0, 500),
        quantity:    Number(l.quantity) || 0,
        rate:        Number(l.rate) || 0,
        total:       Number(l.total) || 0,
      })).filter(l => l.description)
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
      if (cleanLineItems.length > 0 && Math.abs(itemSum - finalSubtotal) > 0.01) {
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
        line_items:    JSON.stringify(cleanLineItems),
        currency:      project.currency || 'USD',
        due_date:      dueDate || null,
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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
