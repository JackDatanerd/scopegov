export const runtime = 'nodejs'
// Batches every project in the system — same unbounded shape payment-overdue carries this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { CronRun, fetchAll } from '@/lib/utils/cron-run'
import { computeContractPositions } from '@/lib/reports/contract-position'

// Daily. Writes one contract_reconciliation_snapshots row per live project (contracted / invoiced /
// paid / at-risk) for the trend charts and the Invoices portfolio strip. The maths lives in
// lib/reports/contract-position.ts, shared with the invoice render paths (which compute LIVE).
//
// This used to issue 3 queries per project, one project at a time, over an unpaginated (1000-row
// capped) project list — the tail silently got no snapshot, and the whole run scaled linearly in
// round trips. Now: one paginated project scan, then chunked batch queries.
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const run = new CronRun(service, 'reconciliation-rollup')
  let processed = 0, written = 0

  await run.step('snapshot projects', async () => {
    const today = new Date().toISOString().split('T')[0]

    const projects = await fetchAll<any>('reconciliation projects select', (from, to) =>
      (service as any).from('projects')
        .select('id, workspace_id, contract_value, status, type, retainer_duration_months')
        .is('deleted_at', null)
        .neq('status', 'Archived')
        .order('id')
        .range(from, to))
    processed = projects.length

    const positions = await computeContractPositions(service, projects)

    // Upsert in batches — one bad row must not lose the batch's neighbours, so fall back per row on error.
    const rows = projects.map((p: any) => {
      const pos = positions.get(p.id)!
      return {
        workspace_id:     p.workspace_id,
        project_id:       p.id,
        contracted_value: pos.contractedValue,
        invoiced_to_date: pos.invoicedToDate,
        paid_to_date:     pos.paidToDate,
        at_risk_value:    pos.atRiskValue,
        snapshot_date:    today,
      }
    })
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200)
      const { error } = await (service as any).from('contract_reconciliation_snapshots')
        .upsert(batch, { onConflict: 'project_id,snapshot_date' })
      if (!error) { written += batch.length; continue }
      for (const row of batch) {
        const { error: rowErr } = await (service as any).from('contract_reconciliation_snapshots')
          .upsert(row, { onConflict: 'project_id,snapshot_date' })
        if (rowErr) run.rowError(`snapshot ${row.project_id}`, rowErr)
        else written++
      }
    }
    Object.assign(run.result, { projectsProcessed: processed, snapshotsWritten: written })
  })

  const { body, status } = await run.finish()
  return NextResponse.json(body, { status })
}

// Vercel Cron invokes the configured path with GET; the GitHub Actions backup uses POST.
export const GET = POST
