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

import { PERIOD_LABELS as ALL_PERIOD_LABELS, PERIOD_DAYS, type PeriodKey } from './period'
import {
  computeScopeHealth, SEVERITY_RANK, SEVERITY_MULTIPLIER, OPEN_FLAG_RISK_RATE, type CurrencyRollup,
} from './scope-health'
import { fetchPaged } from '@/lib/utils/paginate'

export type PortfolioPeriod = PeriodKey

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
    /**
     * Null whenever this point's own currency (see `currency` below) isn't
     * the CURRENT dominant currency — see the FIX note on the trend-chart
     * guard in getPortfolioData for why a mismatched figure must never be
     * plotted under today's currency label instead of silently dropped.
     */
    contractValueAtRisk: number | null
    exceptionsCount: number
    /** Dominant currency THIS snapshot was computed in on the day it ran. */
    currency: string
  }>
  /** Live figures vs the first snapshot inside the period (null when there is no comparable snapshot). */
  trend: { openFlagsDelta: number; atRiskDelta: number | null } | null
  /** Exact number of open flags (the list below is capped per severity). */
  openFlagsTotal: number
  /**
   * Up to `flagsPerSeverity` flags of EACH severity, high → medium → low then newest first. It is per severity
   * (not one overall cap) so filtering the list to "low" can never come up empty just because the newest 100
   * flags happened to be higher severity — the counts in `current.openFlagsBySeverity` say how many exist.
   */
  openFlags: Array<{
    id: string; severity: string; description: string; sowReference: string
    createdAt: string; projectId: string; projectName: string; clientName: string | null
    contractValue: number | null; currency: string
  }>
  /**
   * Every document that needs the agency's action, oldest first: stalled SOWs and COs (the Stalled tile) plus
   * declined / expired / changes-requested SOWs and declined / expired / countered COs — the same states the
   * Dashboard's Needs-attention register already treats as action items.
   */
  stuckDocs: Array<{
    kind: 'SOW' | 'CO'; reason: string; stalled: boolean; title: string; total: number | null; currency: string
    projectId: string; projectName: string; clientName: string | null; since: string
  }>
  /** "Projects by risk": in-progress projects with at least one signal, biggest exposure first. */
  projectRisk: Array<{
    projectId: string; projectName: string; clientName: string | null; status: string; currency: string
    effectiveValue: number | null
    openFlags: number; highFlags: number; borderlineFlags: number
    flagRisk: number | null; exceptionsCount: number; exceptionsRisk: number | null; atRisk: number | null
    stuckDocs: number
  }>
  /** Newest exceptions (all-time), capped; `exceptionsTotal` is the exact count. */
  exceptions: Array<{
    id: string; projectId: string; projectName: string; clientName: string | null
    deliverable: string; grantedWhat: string; reason: string
    estimatedValue: number | null; currency: string; createdAt: string
  }>
  exceptionsTotal: number
  /** The constants behind "Contract value at risk", so the on-page explanation can never drift from the maths. */
  riskModel: { openFlagRate: number; severityMultipliers: { high: number; medium: number; low: number } }
  /** True when at least one daily snapshot exists in the period (chart has history). */
  hasSnapshots: boolean
}

const DEFAULT_FLAGS_PER_SEVERITY = 100
const EXCEPTIONS_LIST_LIMIT = 25
// One row per workspace per day (daily rollup cron) — 20,000 is ~54 years of
// history, effectively unbounded for any real workspace, but still a real
// cap with a real error on the other side of it (see the fetchPaged call
// below), rather than no cap at all.
const HISTORY_MAX_ROWS = 20000

export async function getPortfolioData(
  service: any,
  workspaceId: string,
  period: PeriodKey,
  canViewFinancials: boolean,
  canViewClients: boolean = true,
  opts: { flagsPerSeverity?: number; exceptionsLimit?: number } = {},
): Promise<PortfolioData> {
  const flagsPerSeverity = opts.flagsPerSeverity ?? DEFAULT_FLAGS_PER_SEVERITY
  const exceptionsLimit = opts.exceptionsLimit ?? EXCEPTIONS_LIST_LIMIT
  const days = PERIOD_DAYS[period]
  const since = days === null ? '2000-01-01' : new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
  const now = new Date()
  const today = now.toISOString().split('T')[0]

  const [health, snapPage] = await Promise.all([
    computeScopeHealth(service, workspaceId, { withDetail: true }),
    // BUG fixed (fix round, Portfolio section 8): this was a plain
    // `.select()` with no `.range()`/`.limit()` at all — unlike every other
    // "big read" in this file's own family (computeScopeHealth's five
    // queries), which page with fetchPaged() and explicitly THROW rather
    // than let a truncated read pass as complete, specifically because
    // PostgREST silently caps a plain select at 1000 rows (see
    // lib/utils/paginate.ts). A daily rollup means ~1000 rows is about 2.7
    // years of history — well within reach for `?period=all` (and
    // eventually `12m`/`6m`) on a workspace old enough to have that much
    // history. Past that point this query would have silently returned a
    // truncated series to the chart, the CSV and the PDF with no signal
    // anything was cut off — the exact failure mode the sibling function
    // was written to prevent.
    fetchPaged<any>((from, to) => service
      .from('scope_health_snapshots')
      .select('snapshot_date, open_flags_count, exceptions_count, contract_value_at_risk, currency', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .gte('snapshot_date', since)
      .order('snapshot_date', { ascending: true })
      .range(from, to), { maxRows: HISTORY_MAX_ROWS }),
  ])
  if (snapPage.truncated)
    throw new Error(`Portfolio history truncated: scope_health_snapshots exceeded ${HISTORY_MAX_ROWS} rows for this workspace/period`)

  const snapshots: any[] = snapPage.rows
  const earliest = snapshots.length ? snapshots[0] : null

  const money = (n: number) => (canViewFinancials ? n : null)
  const projectById = new Map(health.projects.map(p => [p.id, p]))

  // Severity first, then newest — capped PER SEVERITY (see the type comment): one overall cap hid every low
  // flag behind newer higher ones, so the severity filter reported "no low flags — scope under control" while
  // hundreds existed.
  const flagsBySeverity: Record<string, typeof health.openFlags> = { high: [], medium: [], low: [] }
  for (const f of health.openFlags) (flagsBySeverity[f.severity] || flagsBySeverity.low).push(f)
  const listedFlags = ['high', 'medium', 'low'].flatMap(sev =>
    flagsBySeverity[sev]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, flagsPerSeverity))

  // History = persisted snapshots + today's live point, so the chart always
  // ends on what the tiles say even before tonight's cron has run.
  //
  // FIX (fix round, Portfolio section 8): a snapshot's contract_value_at_risk
  // was computed under WHATEVER currency was dominant on the day it ran
  // (scope-health-rollup persists `h.currency` alongside it — this module's
  // own snapshot query already selects it) — but every point here used to be
  // plotted, exported and labelled as if it were in TODAY's dominant
  // currency (`data.currency`), with no per-point currency at all. A
  // workspace whose dominant currency shifts over the selected period (this
  // module's own comment above the type says that's a real, designed-for
  // scenario) would silently mix currencies on one line with no signal
  // anything was wrong — the exact failure mode the single-point trend
  // delta below is already guarded against (`earliest.currency ===
  // health.currency`), just never extended to the full series that guard
  // was modelled on. Each point now carries its own currency, and a point
  // whose currency doesn't match today's is nulled out here — at the
  // source, once — rather than trusting the chart/CSV/PDF to each re-derive
  // and apply the same guard independently.
  const nullIfCurrencyMismatch = (value: number, pointCurrency: string) =>
    pointCurrency === health.currency ? money(value) : null

  const history = snapshots.map((h: any) => ({
    date: h.snapshot_date as string,
    openFlagsCount: h.open_flags_count as number,
    contractValueAtRisk: nullIfCurrencyMismatch(Number(h.contract_value_at_risk) || 0, h.currency),
    exceptionsCount: h.exceptions_count as number,
    currency: h.currency as string,
  }))
  const lastDate = history.length ? history[history.length - 1].date : null
  if (!lastDate || lastDate < today) {
    history.push({
      date: today,
      openFlagsCount: health.openFlagsCount,
      contractValueAtRisk: money(health.contractValueAtRisk),
      exceptionsCount: health.exceptionsCount,
      currency: health.currency,
    })
  } else {
    // A snapshot for today exists but may be hours old — show the live values.
    history[history.length - 1] = {
      date: today,
      openFlagsCount: health.openFlagsCount,
      contractValueAtRisk: money(health.contractValueAtRisk),
      exceptionsCount: health.exceptionsCount,
      currency: health.currency,
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
    openFlags: listedFlags.map(f => {
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
    stuckDocs: health.stuckDocs.map(d => {
      const p = projectById.get(d.projectId)
      return {
        kind: d.kind, reason: d.reason, stalled: d.stalled, title: d.title,
        total: canViewFinancials ? d.total : null,
        currency: p?.currency || 'USD',
        projectId: d.projectId, projectName: p?.name || 'Unknown project',
        clientName: canViewClients ? (p?.clientName ?? null) : null,
        since: d.since,
      }
    }),
    projectRisk: health.projectRisk.map(r => {
      const p = projectById.get(r.projectId)
      return {
        projectId: r.projectId, projectName: p?.name || 'Unknown project',
        clientName: canViewClients ? (p?.clientName ?? null) : null,
        status: p?.status || '', currency: p?.currency || 'USD',
        effectiveValue: canViewFinancials && p ? p.effectiveValue : null,
        openFlags: r.openFlags, highFlags: r.highFlags, borderlineFlags: r.borderlineFlags,
        flagRisk: money(r.flagRisk), exceptionsCount: r.exceptionsCount,
        exceptionsRisk: money(r.exceptionsRisk), atRisk: money(r.atRisk),
        stuckDocs: r.stuckDocs,
      }
    }),
    exceptions: health.exceptions.slice(0, exceptionsLimit).map(e => {
      const p = projectById.get(e.projectId)
      return {
        id: e.id, projectId: e.projectId, projectName: p?.name || 'Unknown project',
        clientName: canViewClients ? (p?.clientName ?? null) : null,
        deliverable: e.deliverable, grantedWhat: e.grantedWhat, reason: e.reason,
        estimatedValue: money(e.estimatedValue), currency: p?.currency || 'USD', createdAt: e.createdAt,
      }
    }),
    exceptionsTotal: health.exceptionsCount,
    riskModel: {
      openFlagRate: OPEN_FLAG_RISK_RATE,
      severityMultipliers: {
        high: SEVERITY_MULTIPLIER.high, medium: SEVERITY_MULTIPLIER.medium, low: SEVERITY_MULTIPLIER.low,
      },
    },
    hasSnapshots: snapshots.length > 0,
  }
}

export const PERIOD_LABELS = ALL_PERIOD_LABELS
