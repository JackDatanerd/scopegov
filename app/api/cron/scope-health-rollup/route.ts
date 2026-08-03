export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

function verifyCronSecret(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

// Severity weighting for contract_value_at_risk — a tuning detail, not a
// blocking decision (spec, Phase 2 "Weighting" note). Open flags don't
// carry a dollar amount of their own, so their contribution is estimated
// as a slice of the project's contract value; exceptions_log entries
// already carry a real granted-away dollar amount, so severity only
// discounts those, it doesn't invent them.
const SEVERITY_MULTIPLIER: Record<string, number> = { high: 1.0, medium: 0.5, low: 0.2 }

// Estimated fraction of contract value a single open flag puts at risk,
// before severity weighting. Deliberately conservative — this is an
// early-warning signal for a still-unresolved flag, not a claim about
// actual dollars lost. Adjust freely; it doesn't change the schema.
const OPEN_FLAG_RISK_RATE = 0.05

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    const now = new Date()
    const snapshotDate = now.toISOString().split('T')[0]

    const { data: workspaces } = await (service as any)
      .from('workspaces')
      .select('id')
      .is('deleted_at', null)

    let processed = 0
    const errors: Array<{ workspaceId: string; error: string }> = []

    for (const ws of (workspaces || [])) {
      try {
        await rollupWorkspace(service, ws.id, snapshotDate)
        processed++
      } catch (e) {
        errors.push({ workspaceId: ws.id, error: e instanceof Error ? e.message : 'unknown' })
        console.error(`Scope-health rollup failed for workspace ${ws.id}:`, e)
      }
    }

    return NextResponse.json({ ok: true, processed, failed: errors.length, errors })
  } catch (err) {
    console.error('Scope-health rollup cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

async function rollupWorkspace(service: any, workspaceId: string, snapshotDate: string) {
  const [projectsRes, flagsRes, exceptionsRes, coRes] = await Promise.all([
    service.from('projects')
      .select('id, status, contract_value, currency')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
    service.from('guardian_flags')
      .select('id, project_id, severity, status')
      .eq('workspace_id', workspaceId)
      .eq('status', 'open'),
    // exceptions_log is an append-only ledger (no status column) — this is
    // the cumulative total granted to date, which is what makes the trend
    // chart meaningful (a climbing count/value over time, not a snapshot
    // that resets). Each row optionally carries flag_id, used below to
    // borrow that flag's severity for weighting.
    service.from('exceptions_log')
      .select('id, project_id, estimated_value, flag_id, guardian_flags(severity)')
      .eq('workspace_id', workspaceId),
    service.from('change_orders')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'stalled'),
  ])

  const projects = projectsRes.data || []
  const flags = flagsRes.data || []
  const exceptions = exceptionsRes.data || []
  const stalledCOs = coRes.data || []

  const projectById: Record<string, any> = {}
  for (const p of projects) projectById[p.id] = p

  // Resolve a single reporting currency the same way app/api/reports/route.ts
  // does: most-common currency across active projects. contract_value_at_risk
  // is only ever expressed in one currency per snapshot — never summed
  // across currencies (see BUG note in reports route re: mixed currencies).
  const currencyCounts: Record<string, number> = {}
  for (const p of projects) {
    const c = p.currency || 'USD'
    currencyCounts[c] = (currencyCounts[c] || 0) + 1
  }
  const currency = Object.keys(currencyCounts).sort(
    (a, b) => currencyCounts[b] - currencyCounts[a]
  )[0] || 'USD'

  const bySeverity: Record<string, number> = { high: 0, medium: 0, low: 0 }
  let atRisk = 0

  for (const f of flags) {
    const project = projectById[f.project_id]
    if (!project) continue
    if ((project.currency || 'USD') !== currency) continue // keep single-currency, like reports route
    const sev = f.severity in bySeverity ? f.severity : 'low'
    bySeverity[sev]++
    const mult = SEVERITY_MULTIPLIER[f.severity] ?? SEVERITY_MULTIPLIER.low
    atRisk += (project.contract_value || 0) * OPEN_FLAG_RISK_RATE * mult
  }

  let exceptionsValueTotal = 0
  for (const e of exceptions) {
    const project = projectById[e.project_id]
    if (!project) continue
    if ((project.currency || 'USD') !== currency) continue
    const sev = e.guardian_flags?.severity
    const mult = sev ? (SEVERITY_MULTIPLIER[sev] ?? 1.0) : 1.0
    const value = (e.estimated_value || 0) * mult
    exceptionsValueTotal += (e.estimated_value || 0)
    atRisk += value
  }

  const stalledSowCount = projects.filter(
    (p: any) => p.status === 'Stalled'
  ).length
  const activeProjectCount = projects.filter((p: any) =>
    ['Active', 'Awaiting Signature', 'Intake', 'Changes Requested', 'Stalled'].includes(p.status)
  ).length

  await service.from('scope_health_snapshots').upsert(
    {
      workspace_id: workspaceId,
      snapshot_date: snapshotDate,
      open_flags_count: flags.length,
      open_flags_by_severity: bySeverity,
      exceptions_count: exceptions.length,
      exceptions_value_total: exceptionsValueTotal,
      contract_value_at_risk: Math.round(atRisk * 100) / 100,
      stalled_sow_count: stalledSowCount,
      stalled_co_count: stalledCOs.length,
      active_project_count: activeProjectCount,
      currency,
    },
    { onConflict: 'workspace_id,snapshot_date' }
  )
}

// Vercel Cron invokes the configured path with GET, not POST (see the same
// fix already applied in app/api/cron/payment-overdue/route.ts).
export const GET = POST
