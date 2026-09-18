export const runtime = 'nodejs'
// FEATURE (cron audit, section 17): loops every workspace with 4 queries
// each (already parallelized via Promise.all below); no maxDuration was
// set anywhere for this route, same timeout-risk gap as reconciliation-
// rollup — see the note there.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

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
      // FIX (deep audit, section 8): stall_reason wasn't selected, so
      // stalled_sow_count below couldn't distinguish "stalled because the
      // SOW never got signed" from "stalled manually" — see the fix note
      // at stalledSowCount.
      .select('id, status, stall_reason, contract_value, currency')
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
      .select('id, project_id')
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
  // FIX (deep audit, section 8 — the flagship finding): open_flags_count
  // used to be flags.length — EVERY open flag, all currencies — while
  // open_flags_by_severity only counted flags on dominant-currency
  // projects (the loop below `continue`s past anything else before
  // incrementing bySeverity). That meant the dashboard's headline "open
  // flags" number and its own severity breakdown could disagree for any
  // multi-currency workspace, AND a flag on a minority-currency project
  // was silently invisible in the severity/risk breakdown while still
  // counting in the header — exactly backwards for a governance tool.
  // Count only what actually gets scored, so the header and the
  // breakdown always agree.
  let openFlagsCount = 0

  for (const f of flags) {
    const project = projectById[f.project_id]
    if (!project) continue
    if ((project.currency || 'USD') !== currency) continue // keep single-currency, like reports route
    openFlagsCount++
    const sev = f.severity in bySeverity ? f.severity : 'low'
    bySeverity[sev]++
    const mult = SEVERITY_MULTIPLIER[f.severity] ?? SEVERITY_MULTIPLIER.low
    atRisk += (project.contract_value || 0) * OPEN_FLAG_RISK_RATE * mult
  }

  let exceptionsValueTotal = 0
  // Same fix as openFlagsCount above, for exceptions_count vs
  // exceptions_value_total.
  let exceptionsCount = 0
  for (const e of exceptions) {
    const project = projectById[e.project_id]
    if (!project) continue
    if ((project.currency || 'USD') !== currency) continue
    exceptionsCount++
    const sev = e.guardian_flags?.severity
    const mult = sev ? (SEVERITY_MULTIPLIER[sev] ?? 1.0) : 1.0
    const value = (e.estimated_value || 0) * mult
    exceptionsValueTotal += (e.estimated_value || 0)
    atRisk += value
  }

  // FIX (deep audit, section 8): this used to count every project with
  // status === 'Stalled', regardless of why — but the portfolio API's
  // drill-down list (app/api/reports/portfolio/route.ts) only lists
  // projects with stall_reason === 'sow_unsigned'. A project can also
  // land in 'Stalled' with stall_reason 'manual' (any admin can manually
  // stall a project — see PATCH /api/projects/[id]), which meant the
  // metric-strip count and the drill-down list it labels could disagree.
  // Match the drill-down's own definition of "stalled SOW".
  //
  // FIX (cron audit, section 17 — closing pass): this comment block (and
  // the one below, on activeProjectCount) claimed every other count in
  // this snapshot was already scoped to the dominant currency — false as
  // written. Neither line actually filtered on `currency` at all, so in a
  // multi-currency workspace both disagreed with openFlagsCount/
  // exceptionsCount/stalledCoCount, which are all correctly scoped. Same
  // fix, applied here too.
  const stalledSowCount = projects.filter(
    (p: any) => p.status === 'Stalled' && p.stall_reason === 'sow_unsigned' && (p.currency || 'USD') === currency
  ).length

  // FIX (cron audit, section 17): this used to be stalledCOs.length —
  // every stalled CO in the workspace, regardless of currency — while
  // every other count in this same snapshot (open flags, exceptions,
  // stalled SOWs) is scoped to the snapshot's single dominant currency.
  // In a multi-currency workspace, that made this one field inconsistent
  // with the rest of an otherwise single-currency snapshot. Match the
  // same dominant-currency scoping used everywhere else here.
  const stalledCoCount = stalledCOs.filter((c: any) => {
    const project = projectById[c.project_id]
    return project && (project.currency || 'USD') === currency
  }).length
  const activeProjectCount = projects.filter((p: any) =>
    ['Active', 'Awaiting Signature', 'Intake', 'Changes Requested', 'Stalled'].includes(p.status)
    && (p.currency || 'USD') === currency
  ).length

  await service.from('scope_health_snapshots').upsert(
    {
      workspace_id: workspaceId,
      snapshot_date: snapshotDate,
      open_flags_count: openFlagsCount,
      open_flags_by_severity: bySeverity,
      exceptions_count: exceptionsCount,
      exceptions_value_total: exceptionsValueTotal,
      contract_value_at_risk: Math.round(atRisk * 100) / 100,
      stalled_sow_count: stalledSowCount,
      stalled_co_count: stalledCoCount,
      active_project_count: activeProjectCount,
      currency,
    },
    { onConflict: 'workspace_id,snapshot_date' }
  )
}

// Vercel Cron invokes the configured path with GET, not POST (see the same
// fix already applied in app/api/cron/payment-overdue/route.ts).
export const GET = POST
