export const runtime = 'nodejs'
export const maxDuration = 60

// GET /api/invoices/export?status=&q=
//
// FEATURE (section-12 audit, pass 2): the invoice registry had no way out of the
// browser — an agency's accountant or bookkeeper could not get the ledger without
// screenshotting it. Same filters as the registry page (lib/utils/invoice-registry.ts),
// so the file is exactly the list on screen, but across ALL pages. Gated like the
// page itself (VIEW_FINANCIALS) and scoped to the projects the caller can see;
// the export is audited, the same way the other CSV exports are.

import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { fetchAll } from '@/lib/utils/fetch-all'
import { csvCell, CSV_BOM } from '@/lib/utils/csv'
import { parseRegistryFilters, projectIdsMatching, applyRegistryFilters } from '@/lib/utils/invoice-registry'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_FINANCIALS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })
    // The registry itself shows a solo-plan workspace only its 10 latest invoices.
    if (session.planTier === 'solo')
      return NextResponse.json({ error: 'Invoice export is available on Starter and above.' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const filters = parseRegistryFilters({ status: searchParams.get('status') || '', q: searchParams.get('q') || '' })

    const service = createServiceClient()
    let allowedProjectIds: string[] | null = null
    if (!hasPermission(session, 'VIEW_ALL_PROJECTS')) {
      const { data: ids } = await (service as any)
        .from('project_members')
        .select('project_id, projects!inner(workspace_id), workspace_members!inner(user_id)')
        .eq('projects.workspace_id', session.workspaceId)
        .eq('workspace_members.user_id', session.id)
      allowedProjectIds = (ids || []).map((r: any) => r.project_id)
    }
    const textProjectIds = await projectIdsMatching(service, session.workspaceId, filters.q)

    const rows = await fetchAll<any>('invoice export', (from, to) => {
      let q = (service as any)
        .from('invoices')
        .select(`id, invoice_number, title, status, currency, amount, subtotal, tax_rate, tax_inclusive, amount_paid,
          due_date, sent_at, paid_at, voided_at, created_at, po_number, disputed_at, dispute_resolved_at,
          projects!inner(name, deleted_at, clients(name, company_name))`)
        .eq('workspace_id', session.workspaceId)
        .is('projects.deleted_at', null)
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to)
      if (allowedProjectIds !== null) q = q.in('project_id', allowedProjectIds)
      return applyRegistryFilters(q, filters, textProjectIds)
    })

    const header = [
      'Invoice number', 'Title', 'Status', 'Project', 'Client', 'Currency',
      'Subtotal', 'Tax rate %', 'Tax amount', 'Total', 'Paid', 'Balance due',
      'Issued', 'Due', 'Paid on', 'Voided on', 'PO number', 'Disputed',
    ]
    const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2)
    const lines = [header.map(csvCell).join(',')]
    for (const r of rows) {
      const total = Number(r.amount) || 0
      const subtotal = r.subtotal == null ? total : Number(r.subtotal)
      const paid = Number(r.amount_paid) || 0
      const balance = ['sent', 'partially_paid', 'overdue'].includes(r.status) ? Math.max(0, total - paid) : 0
      lines.push([
        r.invoice_number || '', r.title, r.status, r.projects?.name || '',
        r.projects?.clients?.company_name || r.projects?.clients?.name || '', r.currency,
        money(subtotal), Number(r.tax_rate) || 0, money(total - subtotal), money(total), money(paid), money(balance),
        r.sent_at ? String(r.sent_at).slice(0, 10) : '', r.due_date || '',
        r.paid_at ? String(r.paid_at).slice(0, 10) : '', r.voided_at ? String(r.voided_at).slice(0, 10) : '',
        r.po_number || '', r.disputed_at && !r.dispute_resolved_at ? 'Yes' : '',
      ].map(csvCell).join(','))
    }

    // Build first, audit after — a failed export must not be recorded as a success.
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.exported', entityType: 'workspace', entityId: session.workspaceId,
      metadata: { rows: rows.length, status: filters.status || 'all', search: filters.q || null },
    })

    const day = new Date().toISOString().slice(0, 10)
    return new NextResponse(new Uint8Array(Buffer.from(CSV_BOM + lines.join('\r\n') + '\r\n', 'utf-8')), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="invoices-${day}.csv"`,
      },
    })
  } catch (err) {
    console.error('Invoice export error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
