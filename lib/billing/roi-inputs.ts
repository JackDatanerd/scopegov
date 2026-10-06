// lib/billing/roi-inputs.ts
//
// Loads the workspace's own numbers for the scope-loss calculator. Everything here is READ-ONLY and reuses the code the
// Reports page runs (getScopeReportData), so the calculator can never disagree with Reports about what was granted
// free, how many flags became change orders, or what was recovered.
//
// Windows are the last 12 months, or since the workspace started if that is shorter. Nothing is annualised: a
// 10-day-old trial reports what it has actually done, and the user is told to adjust the figures — a calculator that
// extrapolates a short history upwards would flatter itself.
//
// Money is only ever returned for callers who may see it (VIEW_ALL_PROJECTS and VIEW_FINANCIALS — the same gate as the
// Reports rollup); everyone else gets `measured: null` and the manual calculator.

import { getScopeReportData } from '@/lib/reports/scope-financial-data'
import { fetchPaged } from '@/lib/utils/paginate'
import { LIMIT_COUNTED_STATUSES } from '@/lib/utils/project-status'
import { ownRecoveryRate, type RoiInputs } from '@/lib/billing/roi-model'

export interface MeasuredNumbers {
  currency: string
  /** More than one project currency exists; the figures are for `currency` only. */
  mixedCurrencies: boolean
  windowDays: number
  grantedFreeValue: number
  recoveredValue: number
  totalFlags: number
  convertedToCo: number
  /** Own flag→change-order rate; null with fewer than MIN_FLAGS_FOR_OWN_RATE flags. */
  ownRecoveryRate: number | null
  projectsStarted: number
  avgProjectValue: number
  activeProjects: number
  activeMembers: number
  /** True when any underlying read hit its row cap, so the figures may be short. */
  truncated: boolean
}

export interface RoiLoad {
  measured: MeasuredNumbers | null
  /** Starting values for the form, derived from `measured` (or blank defaults when null). */
  defaults: Partial<RoiInputs>
}

const DAY = 86_400_000

export async function loadRoiInputs(
  service: any,
  wsId: string,
  opts: { canSeeMoney: boolean; workspaceCreatedAt?: string | null; now?: number },
): Promise<RoiLoad> {
  if (!opts.canSeeMoney) return { measured: null, defaults: {} }

  const now = opts.now ?? Date.now()
  const yearAgo = now - 365 * DAY
  const created = opts.workspaceCreatedAt ? Date.parse(opts.workspaceCreatedAt) : NaN
  const sinceMs = Number.isFinite(created) ? Math.max(yearAgo, created) : yearAgo
  const since = new Date(sinceMs).toISOString()
  const windowDays = Math.max(1, Math.round((now - sinceMs) / DAY))

  const [scope, projects, members] = await Promise.all([
    getScopeReportData(service, wsId, since, null, true),
    fetchPaged<{ contract_value: number | null; currency: string | null; status: string | null; created_at: string }>(
      (from, to) => service.from('projects')
        .select('contract_value,currency,status,created_at', { count: 'exact' })
        .eq('workspace_id', wsId).is('deleted_at', null)
        .order('id').range(from, to),
      { maxRows: 5000 },
    ),
    service.from('workspace_members').select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsId).eq('status', 'active'),
  ])
  if (members.error) throw new Error(`roi inputs: members read failed: ${members.error.message}`)

  const currency: string = scope.currency || 'USD'
  const inCurrency = (p: { currency: string | null }) => (p.currency || 'USD') === currency
  const startedInWindow = projects.rows.filter(p => inCurrency(p) && Date.parse(p.created_at) >= sinceMs)
  const valued = startedInWindow.filter(p => Number(p.contract_value) > 0)
  const avgProjectValue = valued.length
    ? Math.round(valued.reduce((s, p) => s + Number(p.contract_value), 0) / valued.length) : 0
  const counted = new Set<string>(LIMIT_COUNTED_STATUSES as readonly string[])
  const activeProjects = projects.rows.filter(p => p.status && counted.has(p.status)).length

  const grantedFreeValue = scope.exceptionsByProject.reduce((s: number, e: any) => s + (Number(e.estimated_value) || 0), 0)
  const totalFlags = scope.metrics.total_flags
  const convertedToCo = scope.metrics.converted_to_co
  const activeMembers = members.count || 0

  const measured: MeasuredNumbers = {
    currency,
    mixedCurrencies: scope.mixedCurrencies,
    windowDays,
    grantedFreeValue,
    recoveredValue: Number(scope.metrics.recovered_value) || 0,
    totalFlags,
    convertedToCo,
    ownRecoveryRate: ownRecoveryRate(totalFlags, convertedToCo),
    projectsStarted: startedInWindow.length,
    avgProjectValue,
    activeProjects,
    activeMembers,
    truncated: !!scope.truncated || projects.truncated,
  }

  const defaults: Partial<RoiInputs> = {
    currency,
    grantedFreeValue,
    seatsNeeded: Math.max(1, activeMembers),
    activeProjectsNeeded: activeProjects,
    ...(startedInWindow.length > 0 ? { projectsPerYear: startedInWindow.length } : {}),
    ...(avgProjectValue > 0 ? { avgProjectValue } : {}),
  }
  return { measured, defaults }
}
