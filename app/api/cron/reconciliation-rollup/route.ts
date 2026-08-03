export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

function verifyCronSecret(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

// Phase 4 — daily rollup writing one contract_reconciliation_snapshots row
// per (project, day). Snapshotting rather than live-computing on every
// dashboard/report load is deliberate: guardian_flags/exceptions_log/
// invoices are event-level tables, not time-series, so a trend chart needs
// point-in-time snapshots rather than an expensive on-the-fly aggregation
// across every project on every page load (same rationale as Phase 2's
// scope_health_snapshots).
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    const today = new Date().toISOString().split('T')[0]

    const { data: projects, error: projErr } = await (service as any)
      .from('projects')
      .select('id, workspace_id, contract_value, status')
      .neq('status', 'archived')

    if (projErr) {
      console.error('Reconciliation rollup: project fetch failed', projErr)
      return NextResponse.json({ error: 'Failed to load projects' }, { status: 500 })
    }

    let written = 0
    for (const project of (projects || [])) {
      try {
        // Contracted value: base contract + accepted amendments. Mirrors
        // the exact effectiveContractValue calc used on the project detail
        // page (BUG-053: amendments.financial_impact already excludes
        // exceptions_log, so this doesn't need to filter that separately).
        const { data: amendments } = await (service as any)
          .from('amendments').select('financial_impact').eq('project_id', project.id)
        const amendmentTotal = (amendments || []).reduce((s: number, a: any) => s + (a.financial_impact || 0), 0)
        const contractedValue = (project.contract_value || 0) + amendmentTotal

        // Invoiced / paid to date — only invoices that were ever actually
        // sent count (draft has nothing sent yet; void was withdrawn).
        // amount_paid is the trigger-maintained running total from
        // invoice_payments (004_invoicing.sql), so summing it here is
        // equivalent to summing invoice_payments directly but cheaper.
        const { data: invoices } = await (service as any)
          .from('invoices').select('amount, amount_paid, status').eq('project_id', project.id)
        const billedInvoices = (invoices || []).filter((i: any) => !['draft', 'void'].includes(i.status))
        const invoicedToDate = billedInvoices.reduce((s: number, i: any) => s + (i.amount || 0), 0)
        const paidToDate     = billedInvoices.reduce((s: number, i: any) => s + (i.amount_paid || 0), 0)

        // At-risk: change orders sent to the client but not yet accepted —
        // same "at risk (pending COs)" definition already shown on the
        // project overview page, rolled here so it's comparable over time.
        const { data: openCos } = await (service as any)
          .from('change_orders').select('total').eq('project_id', project.id)
          .in('status', ['awaiting_response', 'countered'])
        const atRiskValue = (openCos || []).reduce((s: number, c: any) => s + (c.total || 0), 0)

        const { error: upsertErr } = await (service as any)
          .from('contract_reconciliation_snapshots')
          .upsert({
            workspace_id:     project.workspace_id,
            project_id:       project.id,
            contracted_value: contractedValue,
            invoiced_to_date: invoicedToDate,
            paid_to_date:     paidToDate,
            at_risk_value:    atRiskValue,
            snapshot_date:    today,
          }, { onConflict: 'project_id,snapshot_date' })

        if (upsertErr) {
          console.error('Reconciliation rollup: upsert failed', project.id, upsertErr)
          continue
        }
        written++
      } catch (e) { console.error('Reconciliation rollup: project error', project.id, e) }
    }

    return NextResponse.json({ ok: true, projectsProcessed: projects?.length || 0, snapshotsWritten: written })
  } catch (err) {
    console.error('Reconciliation rollup cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron Jobs invoke via GET; alias same as every other cron route here.
export const GET = POST
