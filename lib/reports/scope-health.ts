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
//  * Exposure per project uses the EFFECTIVE contract value — the ONE shared
//    definition in lib/utils/contract-value.ts (base, where a retainer's base
//    is its monthly rate × term, plus accepted change orders, minus
//    retainer-renewal amendments). It used to be "stored contract_value + Σ
//    every amendment": for a retainer that was one month's fee (so a retainer's
//    exposure was 5% of ONE MONTH), and legacy renewal amendments were counted
//    on top of the rate they had already replaced. Open-flag risk is capped at
//    that value: ten open flags cannot put more than 100% of a contract at risk.
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
//
// Note for the history chart: snapshots written before this change used the old effective-value formula, so
// `contractValueAtRisk` for retainer-heavy workspaces steps up once, at the deploy date. Flag counts are unaffected.

import { fetchPaged } from '@/lib/utils/paginate'
import { IN_PROGRESS_STATUSES, isInProgressStatus } from '@/lib/utils/project-status'
import { amendmentImpact, baseContractValue, loadRetainerMonthsBilled } from '@/lib/utils/contract-value'

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
  type: string | null
  status: string
  stallReason: string | null
  currency: string
  contractValue: number
  effectiveValue: number
  clientName: string | null
  updatedAt: string
  /** When the project entered Stalled (projects.stalled_at, migration 077); null if not stalled / unknown. */
  stalledAt: string | null
}

export interface ScopeHealthFlag {
  id: string
  projectId: string
  severity: string
  description: string
  sowReference: string
  createdAt: string
}

/** A document that is stuck and needs the agency's action. `stalled` marks the ones counted in the Stalled tile. */
export interface StuckDocument {
  kind: 'SOW' | 'CO'
  reason: 'SOW unsigned' | 'Stalled' | 'Declined' | 'Expired' | 'Changes requested' | 'Counter-offer'
  stalled: boolean
  docId: string | null
  title: string
  total: number | null
  projectId: string
  /** When it got stuck: stalled_at / declined_at / expires_at where known, else the row's updated_at. */
  since: string
}

/** One row of "Projects by risk". Only in-progress projects with at least one signal appear. */
export interface ProjectRiskRow {
  projectId: string
  openFlags: number
  highFlags: number
  borderlineFlags: number
  /** Severity-weighted open-flag exposure, capped at the project's effective value. */
  flagRisk: number
  exceptionsCount: number
  /** Live exposure from exceptions (in-progress only), severity-weighted like the headline. */
  exceptionsRisk: number
  /** flagRisk + exceptionsRisk — sums, per currency, to the headline "Contract value at risk". */
  atRisk: number
  stuckDocs: number
}

export interface ScopeHealthException {
  id: string
  projectId: string
  deliverable: string
  grantedWhat: string
  reason: string
  estimatedValue: number
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
  projectRisk: ProjectRiskRow[]
  stuckDocs: StuckDocument[]
  /** Every exception on a non-deleted project, newest first (all-time, like the Exceptions panel). */
  exceptions: ScopeHealthException[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

export async function computeScopeHealth(
  service: any,
  workspaceId: string,
  opts: { withDetail?: boolean } = {},
): Promise<ScopeHealth> {
  const withDetail = !!opts.withDetail

  const [projectsP, flagsP, exceptionsP, amendmentsP, cosP, sowsP] = await Promise.all([
    fetchPaged<any>((from, to) => service.from('projects')
      .select('id, name, type, status, stall_reason, stalled_at, contract_value, retainer_duration_months, currency, updated_at, clients(name)', { count: 'exact' })
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
      .select(withDetail
        ? 'id, project_id, estimated_value, deliverable, granted_what, reason, created_at, guardian_flags(severity)'
        : 'id, project_id, estimated_value, guardian_flags(severity)', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .order('id', { ascending: true })
      .range(from, to), { maxRows: MAX_ROWS }),
    fetchPaged<any>((from, to) => service.from('amendments')
      .select('id, project_id, financial_impact, change_orders(is_retainer_renewal)', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .order('id', { ascending: true })
      .range(from, to), { maxRows: MAX_ROWS }),
    // The headline only needs stalled change orders; the detail view also lists the other stuck states
    // (declined / expired / countered) the Dashboard's Needs-attention already treats as action items.
    fetchPaged<any>((from, to) => service.from('change_orders')
      .select(withDetail ? 'id, project_id, status, title, total, updated_at, stalled_at' : 'id, project_id, status', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .in('status', withDetail ? ['stalled', 'declined', 'expired', 'countered'] : ['stalled'])
      .order('id', { ascending: true })
      .range(from, to), { maxRows: MAX_ROWS }),
    withDetail
      ? fetchPaged<any>((from, to) => service.from('sow_documents')
          .select('id, project_id, version, status, updated_at, declined_at, expires_at', { count: 'exact' })
          .eq('workspace_id', workspaceId)
          .neq('status', 'draft')
          .order('id', { ascending: true })
          .range(from, to), { maxRows: MAX_ROWS })
      : Promise.resolve({ rows: [] as any[], truncated: false }),
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
    ['amendments', amendmentsP], ['change_orders', cosP], ['sow_documents', sowsP],
  ].find(([, p]: any) => p.truncated)
  if (truncatedSource) {
    throw new Error(`Scope health computation truncated: ${truncatedSource[0]} exceeded ${MAX_ROWS} rows for this workspace`)
  }

  // Amendments grouped per project (each carries its change order's is_retainer_renewal flag).
  const amendmentsByProject: Record<string, any[]> = {}
  for (const a of amendmentsP.rows) (amendmentsByProject[a.project_id] ||= []).push(a)

  // An OPEN-ENDED retainer (no term) has no fixed total: its contract is the months committed so far.
  const retainerMonths = await loadRetainerMonthsBilled(
    service, projectsP.rows.filter((p: any) => isInProgressStatus(p.status)),
  )

  const projectById: Record<string, ScopeHealthProject> = {}
  for (const p of projectsP.rows) {
    const base = Number(p.contract_value) || 0
    projectById[p.id] = {
      id: p.id,
      name: p.name,
      type: p.type ?? null,
      status: p.status,
      stallReason: p.stall_reason ?? null,
      currency: p.currency || 'USD',
      contractValue: base,
      effectiveValue: Math.max(0, baseContractValue(p, retainerMonths.get(p.id)) + amendmentImpact(amendmentsByProject[p.id], p.type)),
      clientName: p.clients?.name || null,
      updatedAt: p.updated_at,
      stalledAt: p.stalled_at ?? null,
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

  // Per-project rollups (only kept for the detail view's "Projects by risk").
  const risk: Record<string, ProjectRiskRow> = {}
  const riskRow = (id: string) => (risk[id] ||= {
    projectId: id, openFlags: 0, highFlags: 0, borderlineFlags: 0, flagRisk: 0,
    exceptionsCount: 0, exceptionsRisk: 0, atRisk: 0, stuckDocs: 0,
  })

  // Flags → per-project risk (capped at the project's effective value).
  const openFlagsBySeverity = { high: 0, medium: 0, low: 0 }
  let openFlagsCount = 0
  let borderlineFlagsCount = 0
  const flagRiskByProject: Record<string, number> = {}
  const openFlags: ScopeHealthFlag[] = []
  for (const f of flagsP.rows) {
    const p = projectById[f.project_id]
    if (!inProgress(p)) continue
    if (f.status === 'borderline_review') { borderlineFlagsCount++; riskRow(p.id).borderlineFlags++; continue }
    openFlagsCount++
    bucket(p.currency).openFlagsCount++
    const sev = (f.severity in openFlagsBySeverity ? f.severity : 'low') as 'high' | 'medium' | 'low'
    openFlagsBySeverity[sev]++
    const row = riskRow(p.id)
    row.openFlags++
    if (sev === 'high') row.highFlags++
    const mult = SEVERITY_MULTIPLIER[f.severity] ?? SEVERITY_MULTIPLIER.low
    flagRiskByProject[p.id] = (flagRiskByProject[p.id] || 0) + p.effectiveValue * OPEN_FLAG_RISK_RATE * mult
    if (withDetail) {
      openFlags.push({
        id: f.id, projectId: f.project_id, severity: f.severity,
        description: f.description, sowReference: f.sow_reference, createdAt: f.created_at,
      })
    }
  }
  for (const [pid, rawRisk] of Object.entries(flagRiskByProject)) {
    const p = projectById[pid]
    const capped = Math.min(rawRisk, p.effectiveValue)
    bucket(p.currency).contractValueAtRisk += capped
    riskRow(pid).flagRisk = capped
  }

  // Exceptions: all-time count/value for the panel; only in-progress ones add live exposure.
  let exceptionsCount = 0
  const exceptions: ScopeHealthException[] = []
  for (const e of exceptionsP.rows) {
    const p = projectById[e.project_id]
    if (!p) continue                       // deleted project
    exceptionsCount++
    const value = Number(e.estimated_value) || 0
    bucket(p.currency).exceptionsValueTotal += value
    if (withDetail) {
      exceptions.push({
        id: e.id, projectId: e.project_id, deliverable: e.deliverable, grantedWhat: e.granted_what,
        reason: e.reason, estimatedValue: value, createdAt: e.created_at,
      })
    }
    if (inProgress(p)) {
      const sev = e.guardian_flags?.severity
      const mult = sev ? (SEVERITY_MULTIPLIER[sev] ?? 1.0) : 1.0
      bucket(p.currency).contractValueAtRisk += value * mult
      const row = riskRow(p.id)
      row.exceptionsCount++
      row.exceptionsRisk += value * mult
    }
  }
  exceptions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))

  // Stalled change orders (headline count) + every stuck document (detail view).
  const stalledCoCount = cosP.rows.filter((c: any) => c.status === 'stalled' && inProgress(projectById[c.project_id])).length

  const stuckDocs: StuckDocument[] = []
  if (withDetail) {
    for (const p of Object.values(projectById)) {
      if (inProgress(p) && p.status === 'Stalled' && p.stallReason === 'sow_unsigned') {
        stuckDocs.push({
          kind: 'SOW', reason: 'SOW unsigned', stalled: true, docId: null, title: 'Statement of work',
          total: null, projectId: p.id, since: p.stalledAt || p.updatedAt,
        })
      }
    }
    for (const c of cosP.rows) {
      const p = projectById[c.project_id]
      if (!inProgress(p)) continue
      const reason = c.status === 'stalled' ? 'Stalled' : c.status === 'declined' ? 'Declined'
        : c.status === 'expired' ? 'Expired' : 'Counter-offer'
      stuckDocs.push({
        kind: 'CO', reason, stalled: c.status === 'stalled', docId: c.id, title: c.title || 'Change order',
        total: c.total != null ? Number(c.total) : null, projectId: c.project_id,
        since: (c.status === 'stalled' ? c.stalled_at : null) || c.updated_at,
      })
    }
    // A project's CURRENT SOW is its highest non-draft version; only that one can be stuck (an older
    // declined/expired version that was reopened and re-sent is history, not an action item).
    const currentSow = new Map<string, any>()
    for (const s of sowsP.rows) {
      const cur = currentSow.get(s.project_id)
      if (!cur || (s.version ?? 0) > (cur.version ?? 0)) currentSow.set(s.project_id, s)
    }
    for (const [projectId, s] of Array.from(currentSow.entries())) {
      if (!inProgress(projectById[projectId])) continue
      const reason = s.status === 'declined' ? 'Declined' : s.status === 'expired' ? 'Expired'
        : s.status === 'changes_requested' ? 'Changes requested' : null
      if (!reason) continue
      stuckDocs.push({
        kind: 'SOW', reason, stalled: false, docId: s.id, title: 'Statement of work', total: null, projectId,
        since: (s.status === 'declined' ? s.declined_at : s.status === 'expired' ? s.expires_at : null) || s.updated_at,
      })
    }
    stuckDocs.sort((a, b) => a.since.localeCompare(b.since) || (a.docId || '').localeCompare(b.docId || ''))
    for (const d of stuckDocs) riskRow(d.projectId).stuckDocs++
  }

  // Projects by risk: in-progress projects with any signal, biggest exposure first.
  const projectRisk: ProjectRiskRow[] = withDetail
    ? Object.values(risk)
        .filter(r => inProgress(projectById[r.projectId]))
        .map(r => ({ ...r, flagRisk: r2(r.flagRisk), exceptionsRisk: r2(r.exceptionsRisk), atRisk: r2(r.flagRisk + r.exceptionsRisk) }))
        .filter(r => r.openFlags > 0 || r.borderlineFlags > 0 || r.exceptionsCount > 0 || r.stuckDocs > 0)
        .sort((a, b) => b.atRisk - a.atRisk || b.openFlags - a.openFlags || b.stuckDocs - a.stuckDocs
          || (projectById[a.projectId].name).localeCompare(projectById[b.projectId].name))
    : []

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
    projectRisk,
    stuckDocs,
    exceptions: withDetail ? exceptions : [],
  }
}
