// Single source of truth for the workspace-wide scope-health numbers.
//
// Portfolio deep audit: the daily rollup cron and the Portfolio page used to
// compute (or read) these numbers in two different places. The headline
// tiles came from a once-a-day snapshot while the drill-down lists were
// queried live, so the same page could say "5 open flags" above a table
// listing 2, and the tiles were up to 24h stale. Both now call this module:
// the page shows the live figures, the cron just persists the same figures
// as the day's snapshot (history / trend only).
//
// Rules (each fixes a concrete audit finding):
//  * "In progress" projects = IN_PROGRESS_STATUSES — the same definition the
//    dashboard uses. Complete/Archived/Draft/deleted projects never count.
//  * Non-monetary counts (flags, stalled items, projects) span EVERY
//    currency. Only money is single-currency, because summing USD and EUR is
//    meaningless — that is why the money is also broken out per currency
//    (`byCurrency`) instead of the other currencies simply disappearing.
//  * The dominant currency is chosen among IN-PROGRESS projects (a workspace
//    that moved from USD to EUR would otherwise keep reporting USD forever
//    because of its archived history).
//  * Exposure per project uses the EFFECTIVE contract value (base + signed
//    amendments), the same figure the project page shows, and open-flag risk
//    is capped at that value: ten open flags cannot put more than 100% of a
//    contract at risk.
//  * Only exceptions on in-progress projects add to "at risk". Exceptions
//    granted on a project that has since been completed are sunk scope, not
//    live exposure — counting them made the metric monotonic. The all-time
//    exceptions count/value is still returned for the Exceptions panel.
//  * borderline_review flags (Guardian's "needs a human" queue) are counted
//    separately; they are unresolved work but not yet confirmed scope creep,
//    so they don't add to the at-risk money.
//  * Every read is paged (PostgREST silently caps a plain select at 1000
//    rows) and every error THROWS — a failed read must never be mistaken for
//    "nothing wrong", least of all be persisted as an all-zero snapshot.

import { fetchPaged } from '@/lib/utils/paginate'
import { IN_PROGRESS_STATUSES, isInProgressStatus } from '@/lib/utils/project-status'

export { IN_PROGRESS_STATUSES }

export const SEVERITY_MULTIPLIER: Record<string, number> = { high: 1.0, medium: 0.5, low: 0.2 }
export const OPEN_FLAG_RISK_RATE = 0.05
export const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

const MAX_ROWS = 50000

export interface CurrencyRollup {
  currency: string
  activeProjectCount: number
  openFlagsCount: number
  contractValueAtRisk: number
  exceptionsValueTotal: number
}

export interface ScopeHealthProject {
  id: string
  name: string
  status: string
  stallReason: string | null
  currency: string
  contractValue: number
  effectiveValue: number
  clientName: string | null
  updatedAt: string
}

export interface ScopeHealthFlag {
  id: string
  projectId: string
  severity: string
  description: string
  sowReference: string
  createdAt: string
}

export interface ScopeHealth {
  /** Dominant currency among in-progress projects (money fields are in this). */
  currency: string
  openFlagsCount: number
  openFlagsBySeverity: { high: number; medium: number; low: number }
  borderlineFlagsCount: number
  /** All-time, every non-deleted project (Exceptions panel). */
  exceptionsCount: number
  /** All-time value in the dominant currency (Exceptions panel). */
  exceptionsValueTotal: number
  /** Live exposure in the dominant currency — see rules above. */
  contractValueAtRisk: number
  stalledSowCount: number
  stalledCoCount: number
  activeProjectCount: number
  byCurrency: CurrencyRollup[]
  // Detail rows (only populated when withDetail is set — the cron doesn't need them).
  projects: ScopeHealthProject[]
  openFlags: ScopeHealthFlag[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

export async function computeScopeHealth(
  service: any,
  workspaceId: string,
  opts: { withDetail?: boolean } = {},
): Promise<ScopeHealth> {
  const withDetail = !!opts.withDetail

  const [projectsP, flagsP, exceptionsP, amendmentsP, cosP] = await Promise.all([
    fetchPaged<any>((from, to) => service.from('projects')
      .select('id, name, status, stall_reason, contract_value, currency, updated_at, clients(name)', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to), { maxRows: MAX_ROWS }),
    fetchPaged<any>((from, to) => service.from('guardian_flags')
      .select(withDetail
        ? 'id, project_id, severity, status, description, sow_reference, created_at'
        : 'id, project_id, severity, status', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .in('status', ['open', 'borderline_review'])
      .order('id', { ascending: true })
      .range(from, to), { maxRows: MAX_ROWS }),
    fetchPaged<any>((from, to) => service.from('exceptions_log')
      .select('id, project_id, estimated_value, guardian_flags(severity)', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .order('id', { ascending: true })
      .range(from, to), { maxRows: MAX_ROWS }),
    fetchPaged<any>((from, to) => service.from('amendments')
      .select('id, project_id, financial_impact', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .order('id', { ascending: true })
      .range(from, to), { maxRows: MAX_ROWS }),
    fetchPaged<any>((from, to) => service.from('change_orders')
      .select('id, project_id', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .eq('status', 'stalled')
      .order('id', { ascending: true })
      .range(from, to), { maxRows: MAX_ROWS }),
  ])

  // FIX (Portfolio deep audit): fetchPaged computes `truncated` specifically
  // so a read that silently hit MAX_ROWS isn't mistaken for a complete one
  // — but nothing here ever checked it. A truncated read isn't a failed
  // read, so it slipped past this module's own stated invariant (every
  // error THROWS; a bad read must never look like nothing's wrong) and
  // would have quietly undercounted every metric below with no signal to
  // anyone. Extremely unlikely at MAX_ROWS=50,000 per table, but cheap to
  // guard properly rather than leave the safety net unused.
  const truncatedSource = [
    ['projects', projectsP], ['guardian_flags', flagsP], ['exceptions_log', exceptionsP],
    ['amendments', amendmentsP], ['change_orders', cosP],
  ].find(([, p]: any) => p.truncated)
  if (truncatedSource) {
    throw new Error(`Scope health computation truncated: ${truncatedSource[0]} exceeded ${MAX_ROWS} rows for this workspace`)
  }

  // Effective contract value = base + signed amendments (same as the project page).
  const amendmentTotal: Record<string, number> = {}
  for (const a of amendmentsP.rows) {
    amendmentTotal[a.project_id] = (amendmentTotal[a.project_id] || 0) + (Number(a.financial_impact) || 0)
  }

  const projectById: Record<string, ScopeHealthProject> = {}
  for (const p of projectsP.rows) {
    const base = Number(p.contract_value) || 0
    projectById[p.id] = {
      id: p.id,
      name: p.name,
      status: p.status,
      stallReason: p.stall_reason ?? null,
      currency: p.currency || 'USD',
      contractValue: base,
      effectiveValue: Math.max(0, base + (amendmentTotal[p.id] || 0)),
      clientName: p.clients?.name || null,
      updatedAt: p.updated_at,
    }
  }
  const inProgress = (p: ScopeHealthProject | undefined): p is ScopeHealthProject =>
    !!p && isInProgressStatus(p.status)

  // Dominant currency: most in-progress projects (tie → larger total value → name).
  const tally: Record<string, { count: number; value: number }> = {}
  for (const p of Object.values(projectById)) {
    if (!inProgress(p)) continue
    const t = (tally[p.currency] ||= { count: 0, value: 0 })
    t.count++; t.value += p.effectiveValue
  }
  const currency = Object.keys(tally).sort((a, b) =>
    tally[b].count - tally[a].count || tally[b].value - tally[a].value || a.localeCompare(b),
  )[0] || 'USD'

  const roll: Record<string, CurrencyRollup> = {}
  const bucket = (c: string) => (roll[c] ||= {
    currency: c, activeProjectCount: 0, openFlagsCount: 0, contractValueAtRisk: 0, exceptionsValueTotal: 0,
  })

  let activeProjectCount = 0
  let stalledSowCount = 0
  for (const p of Object.values(projectById)) {
    if (!inProgress(p)) continue
    activeProjectCount++
    bucket(p.currency).activeProjectCount++
    if (p.status === 'Stalled' && p.stallReason === 'sow_unsigned') stalledSowCount++
  }

  // Flags → per-project risk (capped at the project's effective value).
  const openFlagsBySeverity = { high: 0, medium: 0, low: 0 }
  let openFlagsCount = 0
  let borderlineFlagsCount = 0
  const flagRiskByProject: Record<string, number> = {}
  const openFlags: ScopeHealthFlag[] = []
  for (const f of flagsP.rows) {
    const p = projectById[f.project_id]
    if (!inProgress(p)) continue
    if (f.status === 'borderline_review') { borderlineFlagsCount++; continue }
    openFlagsCount++
    bucket(p.currency).openFlagsCount++
    const sev = (f.severity in openFlagsBySeverity ? f.severity : 'low') as 'high' | 'medium' | 'low'
    openFlagsBySeverity[sev]++
    const mult = SEVERITY_MULTIPLIER[f.severity] ?? SEVERITY_MULTIPLIER.low
    flagRiskByProject[p.id] = (flagRiskByProject[p.id] || 0) + p.effectiveValue * OPEN_FLAG_RISK_RATE * mult
    if (withDetail) {
      openFlags.push({
        id: f.id, projectId: f.project_id, severity: f.severity,
        description: f.description, sowReference: f.sow_reference, createdAt: f.created_at,
      })
    }
  }
  for (const [pid, risk] of Object.entries(flagRiskByProject)) {
    const p = projectById[pid]
    bucket(p.currency).contractValueAtRisk += Math.min(risk, p.effectiveValue)
  }

  // Exceptions: all-time count/value for the panel; only in-progress ones add live exposure.
  let exceptionsCount = 0
  for (const e of exceptionsP.rows) {
    const p = projectById[e.project_id]
    if (!p) continue                       // deleted project
    exceptionsCount++
    const value = Number(e.estimated_value) || 0
    bucket(p.currency).exceptionsValueTotal += value
    if (inProgress(p)) {
      const sev = e.guardian_flags?.severity
      const mult = sev ? (SEVERITY_MULTIPLIER[sev] ?? 1.0) : 1.0
      bucket(p.currency).contractValueAtRisk += value * mult
    }
  }

  const stalledCoCount = cosP.rows.filter((c: any) => inProgress(projectById[c.project_id])).length

  const byCurrency = Object.values(roll)
    .map(c => ({
      ...c,
      contractValueAtRisk: r2(c.contractValueAtRisk),
      exceptionsValueTotal: r2(c.exceptionsValueTotal),
    }))
    .sort((a, b) => (a.currency === currency ? -1 : b.currency === currency ? 1 : b.activeProjectCount - a.activeProjectCount))

  const dominant = roll[currency]
  return {
    currency,
    openFlagsCount,
    openFlagsBySeverity,
    borderlineFlagsCount,
    exceptionsCount,
    exceptionsValueTotal: r2(dominant?.exceptionsValueTotal || 0),
    contractValueAtRisk: r2(dominant?.contractValueAtRisk || 0),
    stalledSowCount,
    stalledCoCount,
    activeProjectCount,
    byCurrency,
    projects: withDetail ? Object.values(projectById) : [],
    openFlags: withDetail ? openFlags : [],
  }
}
