// lib/reports/portfolio-data.ts
//
// Data assembly for the Portfolio dashboard, its JSON route and the CSV/PDF
// export — one place, so the three can never drift apart.
//
// Portfolio deep audit (this file's job changed):
//  - The headline numbers (`current`) are now computed LIVE by
//    lib/reports/scope-health.ts — the same module the daily rollup cron uses.
//    Before, the tiles were the last daily snapshot while the lists below were
//    queried live, so a page could say "5 open flags" over a table of 2 and be
//    stale for up to 24h (and be completely empty for a new workspace's first
//    day). Snapshots are now used only for history / trend.
//  - Flags and stalled items are no longer filtered to one currency — a flag
//    on a EUR project is still an open flag. Money is single-currency (the
//    dominant one) with a per-currency breakdown (`byCurrency`) alongside.
//  - The open-flag list is ordered by severity (then newest) BEFORE it is
//    capped, so a cap can never hide a high-severity flag behind newer lows.
//  - Client names are withheld from members without VIEW_CLIENT_DATA, the same
//    rule the project page applies.

import { PERIOD_LABELS as ALL_PERIOD_LABELS, type PeriodKey } from './period'
import {
  computeScopeHealth, IN_PROGRESS_STATUSES, SEVERITY_RANK, type CurrencyRollup,
} from './scope-health'

export type PortfolioPeriod = '30d' | '90d' | '6m' | '12m'

export interface PortfolioCurrencyRow {
  currency: string
  activeProjectCount: number
  openFlagsCount: number
  contractValueAtRisk: number | null
  exceptionsValueTotal: number | null
}

export interface PortfolioData {
  /** Currency of every money figure in `current` (the dominant in-progress currency). */
  currency: string
  /** Live figures — always present. */
  current: {
    openFlagsCount: number
    openFlagsBySeverity: { high: number; medium: number; low: number }
    borderlineFlagsCount: number
    exceptionsCount: number
    exceptionsValueTotal: number | null
    contractValueAtRisk: number | null
    stalledSowCount: number
    stalledCoCount: number
    activeProjectCount: number
    /** ISO timestamp the figures were computed at. */
    asOf: string
    byCurrency: PortfolioCurrencyRow[]
  }
  history: Array<{
    date: string
    openFlagsCount: number
    contractValueAtRisk: number | null
    exceptionsCount: number
  }>
  /** Live figures vs the first snapshot inside the period (null when there is no comparable snapshot). */
  trend: { openFlagsDelta: number; atRiskDelta: number | null } | null
  /** Exact number of open flags (the list below is capped). */
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
  /** True when at least one daily snapshot exists in the period (chart has history). */
  hasSnapshots: boolean
}

const PERIOD_DAYS: Record<PeriodKey, number | null> = { '30d': 30, '90d': 90, '6m': 180, '12m': 365, 'all': null }
const OPEN_FLAGS_LIST_LIMIT = 100
const STALLED_CO_LIST_LIMIT = 500

export async function getPortfolioData(
  service: any,
  workspaceId: string,
  period: PeriodKey,
  canViewFinancials: boolean,
  canViewClients: boolean = true,
): Promise<PortfolioData> {
  const days = PERIOD_DAYS[period]
  const since = days === null ? '2000-01-01' : new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
  const now = new Date()
  const today = now.toISOString().split('T')[0]

  const [health, snapRes, stalledCosRes] = await Promise.all([
    computeScopeHealth(service, workspaceId, { withDetail: true }),
    service
      .from('scope_health_snapshots')
      .select('snapshot_date, open_flags_count, exceptions_count, contract_value_at_risk, currency')
      .eq('workspace_id', workspaceId)
      .gte('snapshot_date', since)
      .order('snapshot_date', { ascending: true }),
    service.from('change_orders')
      .select('id, title, total, project_id, updated_at, projects!inner(id, name, currency, status, deleted_at)')
      .eq('workspace_id', workspaceId).eq('status', 'stalled')
      .is('projects.deleted_at', null)
      .in('projects.status', [...IN_PROGRESS_STATUSES])
      .order('updated_at', { ascending: true })
      .limit(STALLED_CO_LIST_LIMIT),
  ])
  if (snapRes.error) throw new Error(`snapshots: ${snapRes.error.message}`)
  if (stalledCosRes.error) throw new Error(`stalled COs: ${stalledCosRes.error.message}`)

  const snapshots: any[] = snapRes.data || []
  const earliest = snapshots.length ? snapshots[0] : null

  const money = (n: number) => (canViewFinancials ? n : null)
  const projectById = new Map(health.projects.map(p => [p.id, p]))

  // Severity first (a cap must never hide a high behind newer lows), then newest.
  const sortedFlags = [...health.openFlags].sort((a, b) =>
    (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
    || b.createdAt.localeCompare(a.createdAt)
    || b.id.localeCompare(a.id),
  )

  // History = persisted snapshots + today's live point, so the chart always
  // ends on what the tiles say even before tonight's cron has run.
  const history = snapshots.map((h: any) => ({
    date: h.snapshot_date as string,
    openFlagsCount: h.open_flags_count as number,
    contractValueAtRisk: money(Number(h.contract_value_at_risk) || 0),
    exceptionsCount: h.exceptions_count as number,
  }))
  const lastDate = history.length ? history[history.length - 1].date : null
  if (!lastDate || lastDate < today) {
    history.push({
      date: today,
      openFlagsCount: health.openFlagsCount,
      contractValueAtRisk: money(health.contractValueAtRisk),
      exceptionsCount: health.exceptionsCount,
    })
  } else {
    // A snapshot for today exists but may be hours old — show the live values.
    history[history.length - 1] = {
      date: today,
      openFlagsCount: health.openFlagsCount,
      contractValueAtRisk: money(health.contractValueAtRisk),
      exceptionsCount: health.exceptionsCount,
    }
  }

  const comparable = earliest && earliest.snapshot_date < today
  const trend = comparable ? {
    openFlagsDelta: health.openFlagsCount - earliest.open_flags_count,
    // Money deltas only make sense within one currency.
    atRiskDelta: canViewFinancials && earliest.currency === health.currency
      ? Math.round((health.contractValueAtRisk - Number(earliest.contract_value_at_risk)) * 100) / 100
      : null,
  } : null

  return {
    currency: health.currency,
    current: {
      openFlagsCount: health.openFlagsCount,
      openFlagsBySeverity: health.openFlagsBySeverity,
      borderlineFlagsCount: health.borderlineFlagsCount,
      exceptionsCount: health.exceptionsCount,
      exceptionsValueTotal: money(health.exceptionsValueTotal),
      contractValueAtRisk: money(health.contractValueAtRisk),
      stalledSowCount: health.stalledSowCount,
      stalledCoCount: health.stalledCoCount,
      activeProjectCount: health.activeProjectCount,
      asOf: now.toISOString(),
      byCurrency: health.byCurrency.map((c: CurrencyRollup) => ({
        currency: c.currency,
        activeProjectCount: c.activeProjectCount,
        openFlagsCount: c.openFlagsCount,
        contractValueAtRisk: money(c.contractValueAtRisk),
        exceptionsValueTotal: money(c.exceptionsValueTotal),
      })),
    },
    history,
    trend,
    openFlagsTotal: health.openFlagsCount,
    openFlags: sortedFlags.slice(0, OPEN_FLAGS_LIST_LIMIT).map(f => {
      const p = projectById.get(f.projectId)
      return {
        id: f.id,
        severity: f.severity,
        description: f.description,
        sowReference: f.sowReference,
        createdAt: f.createdAt,
        projectId: f.projectId,
        projectName: p?.name || 'Unknown project',
        clientName: canViewClients ? (p?.clientName ?? null) : null,
        contractValue: canViewFinancials && p ? p.effectiveValue : null,
        currency: p?.currency || 'USD',
      }
    }),
    stalledSows: health.projects
      .filter(p => p.status === 'Stalled' && p.stallReason === 'sow_unsigned')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map(p => ({
        projectId: p.id, projectName: p.name,
        clientName: canViewClients ? p.clientName : null, since: p.updatedAt,
      })),
    stalledCos: (stalledCosRes.data || []).map((c: any) => ({
      id: c.id, title: c.title, total: canViewFinancials ? c.total : null,
      currency: c.projects?.currency || 'USD',
      projectId: c.project_id, projectName: c.projects?.name || 'Unknown project', since: c.updated_at,
    })),
    hasSnapshots: snapshots.length > 0,
  }
}

export const PERIOD_LABELS = ALL_PERIOD_LABELS
