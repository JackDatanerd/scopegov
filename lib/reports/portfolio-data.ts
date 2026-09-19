// lib/reports/portfolio-data.ts
//
// FIX (deep audit, section 8 — feature gap): the Portfolio dashboard had
// no export at all — unlike the general Reports section (api/reports/
// audit-export), which offers CSV and PDF. For a product whose whole
// pitch is portfolio-level oversight for agency leadership, "hand this to
// a partner/board member who doesn't have a login" is a basic expectation
// of the feature, not a nice-to-have. Rather than duplicate the drill-down
// queries into a second route (and risk the two drifting apart the way
// several currency-scoping bugs already found in this section did),
// the data assembly lives here once — the JSON route and the new
// CSV/PDF export route both call getPortfolioData().

import { PERIOD_LABELS as ALL_PERIOD_LABELS, type PeriodKey } from './period'

export type PortfolioPeriod = '30d' | '90d' | '6m' | '12m'

export interface PortfolioData {
  currency: string
  current: {
    openFlagsCount: number
    openFlagsBySeverity: { high: number; medium: number; low: number }
    exceptionsCount: number
    exceptionsValueTotal: number | null
    contractValueAtRisk: number | null
    stalledSowCount: number
    stalledCoCount: number
    activeProjectCount: number
    snapshotDate: string
  } | null
  history: Array<{
    date: string
    openFlagsCount: number
    contractValueAtRisk: number | null
    exceptionsCount: number
  }>
  trend: { openFlagsDelta: number; atRiskDelta: number | null } | null
  /** Exact number of open flags in the dominant currency (the list below is capped). */
  openFlagsTotal: number
  openFlags: Array<{
    id: string; severity: string; description: string; sowReference: string
    createdAt: string; projectId: string; projectName: string; clientName: string | null
    contractValue: number | null; currency: string
  }>
  stalledSows: Array<{ projectId: string; projectName: string; clientName: string | null; since: string }>
  stalledCos: Array<{
    id: string; title: string; total: number | null; currency: string
    projectId: string; projectName: string; since: string
  }>
  hasSnapshots: boolean
}

const PERIOD_DAYS: Record<PeriodKey, number | null> = { '30d': 30, '90d': 90, '6m': 180, '12m': 365, 'all': null }
const OPEN_FLAGS_LIST_LIMIT = 100

export async function getPortfolioData(
  service: any,
  workspaceId: string,
  period: PeriodKey,
  canViewFinancials: boolean
): Promise<PortfolioData> {
  const days = PERIOD_DAYS[period]
  const since = days === null ? '2000-01-01' : new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { data: snapshots, error: snapErr } = await service
    .from('scope_health_snapshots')
    .select('snapshot_date, open_flags_count, open_flags_by_severity, exceptions_count, exceptions_value_total, contract_value_at_risk, stalled_sow_count, stalled_co_count, active_project_count, currency')
    .eq('workspace_id', workspaceId)
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: true })
  if (snapErr) throw new Error(`snapshots: ${snapErr.message}`)

  const history = snapshots || []
  const latest = history.length ? history[history.length - 1] : null
  const earliest = history.length ? history[0] : null

  // Scoped to the snapshot's single dominant currency — see
  // app/api/cron/scope-health-rollup/route.ts for why open_flags_count /
  // stalled_co_count are computed that way, and why these drill-downs
  // need to match it or the header counts and the lists underneath them
  // can disagree.
  const dominantCurrency = latest?.currency || 'USD'

  // FIX (Reports & Audit re-pass #3): the headline counts come from the
  // scope-health rollup, which excludes soft-deleted projects
  // (`deleted_at is null`). These drill-downs did not, so a deleted
  // project's open flags / stalled items were listed under a header count
  // that didn't include them. Same filter here; errors are surfaced instead
  // of silently rendering an empty list; the flag list reports its exact
  // total so a capped list can say so.
  const { data: openFlags, error: flagsErr, count: openFlagsTotal } = await service
    .from('guardian_flags')
    .select('id, severity, description, sow_reference, created_at, project_id, projects!inner(id, name, contract_value, currency, clients(name))', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('status', 'open')
    .eq('projects.currency', dominantCurrency)
    .is('projects.deleted_at', null)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(OPEN_FLAGS_LIST_LIMIT)
  if (flagsErr) throw new Error(`open flags: ${flagsErr.message}`)

  const [stalledSowsRes, stalledCosRes] = await Promise.all([
    service.from('projects')
      .select('id, name, updated_at, clients(name)')
      .eq('workspace_id', workspaceId).eq('status', 'Stalled').eq('stall_reason', 'sow_unsigned')
      .is('deleted_at', null)
      .order('updated_at', { ascending: true }),
    service.from('change_orders')
      .select('id, title, total, project_id, updated_at, projects!inner(id, name, currency)')
      .eq('workspace_id', workspaceId).eq('status', 'stalled')
      .eq('projects.currency', dominantCurrency)
      .is('projects.deleted_at', null)
      .order('updated_at', { ascending: true }),
  ])
  if (stalledSowsRes.error) throw new Error(`stalled SOWs: ${stalledSowsRes.error.message}`)
  if (stalledCosRes.error) throw new Error(`stalled COs: ${stalledCosRes.error.message}`)

  const trend = earliest && latest ? {
    openFlagsDelta: latest.open_flags_count - earliest.open_flags_count,
    atRiskDelta: canViewFinancials
      ? Math.round((latest.contract_value_at_risk - earliest.contract_value_at_risk) * 100) / 100
      : null,
  } : null

  return {
    currency: latest?.currency || 'USD',
    current: latest ? {
      openFlagsCount: latest.open_flags_count,
      openFlagsBySeverity: latest.open_flags_by_severity,
      exceptionsCount: latest.exceptions_count,
      exceptionsValueTotal: canViewFinancials ? latest.exceptions_value_total : null,
      contractValueAtRisk: canViewFinancials ? latest.contract_value_at_risk : null,
      stalledSowCount: latest.stalled_sow_count,
      stalledCoCount: latest.stalled_co_count,
      activeProjectCount: latest.active_project_count,
      snapshotDate: latest.snapshot_date,
    } : null,
    history: history.map((h: any) => ({
      date: h.snapshot_date,
      openFlagsCount: h.open_flags_count,
      contractValueAtRisk: canViewFinancials ? h.contract_value_at_risk : null,
      exceptionsCount: h.exceptions_count,
    })),
    trend,
    openFlagsTotal: openFlagsTotal ?? (openFlags || []).length,
    openFlags: (openFlags || []).map((f: any) => ({
      id: f.id,
      severity: f.severity,
      description: f.description,
      sowReference: f.sow_reference,
      createdAt: f.created_at,
      projectId: f.project_id,
      projectName: f.projects?.name || 'Unknown project',
      clientName: f.projects?.clients?.name || null,
      contractValue: canViewFinancials ? f.projects?.contract_value : null,
      currency: f.projects?.currency || 'USD',
    })),
    stalledSows: (stalledSowsRes.data || []).map((p: any) => ({
      projectId: p.id, projectName: p.name, clientName: p.clients?.name || null, since: p.updated_at,
    })),
    stalledCos: (stalledCosRes.data || []).map((c: any) => ({
      id: c.id, title: c.title, total: canViewFinancials ? c.total : null,
      currency: c.projects?.currency || 'USD',
      projectId: c.project_id, projectName: c.projects?.name || 'Unknown project', since: c.updated_at,
    })),
    hasSnapshots: history.length > 0,
  }
}

export const PERIOD_LABELS = ALL_PERIOD_LABELS
