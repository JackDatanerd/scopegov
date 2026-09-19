// lib/reports/scope-financial-data.ts
//
// Shared by app/api/reports/route.ts (the on-screen report) and
// app/api/reports/export/route.ts (CSV/PDF), so both compute the identical
// scope/financial payload instead of two copies that could drift apart.
//
// Reports & Audit re-pass #3 — what changed in this file and why:
//
//  1. Reads are paged (`fetchPaged`) instead of `.limit(MAX + 1)`. PostgREST's
//     max-rows cap (Supabase default 1000) silently beats `.limit()`, so the
//     old "truncated" flag could never fire and a busy workspace's rollup
//     came back short while claiming to be complete.
//  2. Read ERRORS are thrown, not swallowed. Every result used to be
//     `res.data || []`, so a failed query rendered as a confident wall of
//     zeros.
//  3. "Converted to CO" now counts flags whose change order was ACCEPTED.
//     finalize-co moves a flag to status 'resolved' / resolution
//     'change_order' on acceptance, and the old filter (status ===
//     'converted_to_co') only matched flags whose CO was still in flight —
//     so the headline recovery metric fell every time a client said yes.
//  4. Flags dismissed as 'not_out_of_scope' and borderline flags still
//     awaiting review are no longer counted as "raised" (they inflated the
//     denominator of the recovery rate); both are exposed separately.
//  5. The CO grid reconciles: only SENT change orders count, each revision
//     lineage counts once (superseded parents are dropped), and every status
//     lands in exactly one bucket so raised === accepted + declined +
//     pending + closed.
//  6. Financial "effective value" no longer mixes an all-time base with a
//     period-filtered amendment total. Portfolio value (base + ALL accepted
//     amendments) is a point-in-time snapshot; `co_impact` is the amendment
//     value added inside the selected period.
//  7. Retainer-renewal amendments are excluded from additive sums:
//     finalize-co overwrites projects.contract_value with the new monthly
//     rate AND writes an amendment for the same total, so summing both
//     double-counted the renewal (and reported the whole new rate as
//     "recovered").
//  8. The currency picker no longer sorts `availableCurrencies` in place.
//  9. Every multi-page read is pinned to a single "as of now" instant
//     (`asOf`, captured once per call) via an upper bound on whichever
//     time column each query orders by. Without it, a row created between
//     this call's first and a later page — landing at the FRONT of a
//     descending `created_at`/`adjusted_at`/`sent_at` order — shifts every
//     later row's offset by one, so a busy workspace could see one row
//     counted twice (inflating a sum) or skipped once (undercounting it)
//     across a single rollup. audit-export already solved this exact
//     problem for its own pagination; this is the same fix applied here.
//     `projects` doesn't need it — it orders by `id` (random UUIDs), not a
//     time-correlated column, so a new row can't shift an existing one's
//     position.

import { PROJECT_TYPE_LABELS } from '@/lib/utils/format'
import { fetchPaged } from '@/lib/utils/paginate'
export { PERIOD_LABELS, periodSince, parsePeriod, type PeriodKey } from './period'

const MAX_ROLLUP_ROWS = 5000

async function loadAll<T = any>(
  label: string,
  build: (from: number, to: number) => PromiseLike<any>,
): Promise<{ rows: T[]; truncated: boolean }> {
  try {
    const res = await fetchPaged<T>(build, { maxRows: MAX_ROLLUP_ROWS })
    return { rows: res.rows, truncated: res.truncated }
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const NO_CURRENCY = '__no_active_project__'

export function pickCurrency(currencyCounts: Record<string, number>, requested: string | null) {
  const availableCurrencies = Object.keys(currencyCounts).sort()
  const byCount = [...availableCurrencies].sort((a, b) => currencyCounts[b] - currencyCounts[a])
  const currency = (requested && availableCurrencies.includes(requested))
    ? requested
    : (byCount[0] || 'USD')
  return { availableCurrencies, mixedCurrencies: availableCurrencies.length > 1, currency }
}

// finalize-co: a retainer-renewal CO on a type:'retainer' project REPLACES
// projects.contract_value with the CO total (the new monthly rate) and also
// writes an amendment of the same amount. It is not additive.
export function isNonAdditiveAmendment(a: any, projectType: string | undefined): boolean {
  return a?.change_orders?.is_retainer_renewal === true && projectType === 'retainer'
}

// ── Flag classification ────────────────────────────────────────────────
export function classifyFlag(f: { status: string; resolution?: string | null }) {
  const dismissed = f.resolution === 'not_out_of_scope'
  const pendingReview = f.status === 'borderline_review'
  const converted = f.status === 'converted_to_co' || (f.status === 'resolved' && f.resolution === 'change_order')
  return { dismissed, pendingReview, converted, counted: !dismissed && !pendingReview }
}

// ── CO grid ────────────────────────────────────────────────────────────
const CO_PENDING = new Set(['awaiting_response', 'countered', 'stalled', 'awaiting_countersignature'])
const CO_CLOSED = new Set(['withdrawn', 'closed', 'expired', 'exception_granted'])

export function buildCoGrid(cos: Array<{ id: string; status: string; parent_co_id?: string | null; sent_at?: string | null }>) {
  const sent = cos.filter(c => !!c.sent_at)
  const supersededIds = new Set(sent.map(c => c.parent_co_id).filter(Boolean) as string[])
  const live = sent.filter(c => !supersededIds.has(c.id))
  const accepted = live.filter(c => c.status === 'accepted').length
  const declined = live.filter(c => c.status === 'declined').length
  const pending = live.filter(c => CO_PENDING.has(c.status)).length
  const closed = live.filter(c => CO_CLOSED.has(c.status)).length
  // Any status we don't know yet is counted as pending rather than dropped,
  // so raised always equals the sum of the four buckets.
  const unknown = live.length - accepted - declined - pending - closed
  return { raised: live.length, accepted, declined, pending: pending + unknown, closed }
}

export async function getScopeReportData(
  service: any, wsId: string, since: string, requestedCurrency: string | null, canSeeFinancials: boolean
) {
  // See file header, point 9: pins every time-ordered read to one instant.
  const asOf = new Date().toISOString()
  const [flagsQ, exceptionsQ, adjustmentsQ, amendmentsQ, projectsQ] = await Promise.all([
    loadAll('flags', (f, t) => service.from('guardian_flags')
      .select('id,status,resolution,projects(id,name)', { count: 'exact' })
      .eq('workspace_id', wsId).gte('created_at', since).lte('created_at', asOf)
      .order('created_at', { ascending: false }).order('id').range(f, t)),
    loadAll('exceptions', (f, t) => service.from('exceptions_log')
      .select('id,deliverable,estimated_value,project_id,projects(id,name,currency)', { count: 'exact' })
      .eq('workspace_id', wsId).gte('created_at', since).lte('created_at', asOf)
      .order('created_at', { ascending: false }).order('id').range(f, t)),
    loadAll('scope adjustments', (f, t) => service.from('scope_adjustments')
      .select('id,deliverable,old_value,new_value,reason,adjusted_at,project_id,projects(id,name)', { count: 'exact' })
      .eq('workspace_id', wsId).gte('adjusted_at', since).lte('adjusted_at', asOf)
      .order('adjusted_at', { ascending: false }).order('id').range(f, t)),
    loadAll('amendments', (f, t) => service.from('amendments')
      .select('id,financial_impact,project_id,change_orders(is_retainer_renewal)', { count: 'exact' })
      .eq('workspace_id', wsId).gte('created_at', since).lte('created_at', asOf)
      .order('created_at', { ascending: false }).order('id').range(f, t)),
    loadAll('projects', (f, t) => service.from('projects')
      .select('id,currency,type', { count: 'exact' })
      .eq('workspace_id', wsId).is('deleted_at', null)
      .order('id').range(f, t)),
  ])

  const truncated = [flagsQ, exceptionsQ, adjustmentsQ, amendmentsQ, projectsQ].some(q => q.truncated)

  const flags = flagsQ.rows
  const exceptions = exceptionsQ.rows
  const allAdjustments = adjustmentsQ.rows
  const allAmendments = amendmentsQ.rows
  const projCurrencyById: Record<string, string> = {}
  const projTypeById: Record<string, string> = {}
  for (const p of projectsQ.rows as any[]) {
    projCurrencyById[p.id] = p.currency || 'USD'
    projTypeById[p.id] = p.type
  }

  const currencyCounts: Record<string, number> = {}
  for (const c of Object.values(projCurrencyById)) currencyCounts[c] = (currencyCounts[c] || 0) + 1
  const { availableCurrencies, mixedCurrencies, currency } = pickCurrency(currencyCounts, requestedCurrency)

  // A project missing from projCurrencyById (soft-deleted, or otherwise gone)
  // must never match ANY selected currency.
  const inCurrency = (projectId: string | undefined) => (projCurrencyById[projectId ?? ''] ?? NO_CURRENCY) === currency

  const amendments = allAmendments.filter((a: any) =>
    inCurrency(a.project_id) && !isNonAdditiveAmendment(a, projTypeById[a.project_id]))
  const exceptionsInCurrency = exceptions.filter((e: any) => inCurrency(e.project_id))
  const recoveredValue = amendments.reduce((s: number, a: any) => s + (Number(a.financial_impact) || 0), 0)

  const flagsInCurrency = flags.filter((f: any) => inCurrency(f.projects?.id))
  const classified = flagsInCurrency.map((f: any) => ({ f, c: classifyFlag(f) }))
  const counted = classified.filter(x => x.c.counted)

  const flagMapInCurrency: Record<string, { project_id: string; project_name: string; flag_count: number }> = {}
  for (const { f } of counted) {
    const pid = f.projects?.id
    if (!pid) continue
    if (!flagMapInCurrency[pid]) flagMapInCurrency[pid] = { project_id: pid, project_name: f.projects.name, flag_count: 0 }
    flagMapInCurrency[pid].flag_count++
  }

  const adjustmentsInCurrency = allAdjustments.filter((a: any) => inCurrency(a.project_id))

  return {
    metrics: {
      total_flags:     counted.length,
      converted_to_co: counted.filter(x => x.c.converted).length,
      dismissed_flags: classified.filter(x => x.c.dismissed).length,
      pending_review_flags: classified.filter(x => x.c.pendingReview).length,
      recovered_value: canSeeFinancials ? recoveredValue : null,
    },
    flagsByProject: Object.values(flagMapInCurrency).sort((a, b) => b.flag_count - a.flag_count),
    exceptionsByProject: exceptionsInCurrency.map((e: any) => ({
      ...e,
      estimated_value: canSeeFinancials ? e.estimated_value : null,
    })),
    adjustments: adjustmentsInCurrency,
    currency,
    mixedCurrencies,
    availableCurrencies,
    truncated,
  }
}

export async function getFinancialReportData(
  service: any, wsId: string, since: string, requestedCurrency: string | null
) {
  // See file header, point 9: pins every time-ordered read to one instant.
  const asOf = new Date().toISOString()
  const [projectsQ, amendmentsQ, cosQ] = await Promise.all([
    loadAll('projects', (f, t) => service.from('projects')
      .select('id,name,type,contract_value,currency,client_id,clients(id,name)', { count: 'exact' })
      .eq('workspace_id', wsId).is('deleted_at', null).neq('status', 'Draft').neq('status', 'Archived')
      .order('id').range(f, t)),
    // ALL amendments up to `asOf` (not just the period's): the portfolio's
    // effective value is base + every accepted amendment; the period only
    // scopes `co_impact` (filtered client-side below, also against `asOf`).
    loadAll('amendments', (f, t) => service.from('amendments')
      .select('id,financial_impact,project_id,created_at,change_orders(is_retainer_renewal)', { count: 'exact' })
      .eq('workspace_id', wsId).lte('created_at', asOf)
      .order('created_at', { ascending: false }).order('id').range(f, t)),
    // COs SENT in the period (drafts have sent_at null and never match).
    loadAll('change orders', (f, t) => service.from('change_orders')
      .select('id,status,total,project_id,parent_co_id,sent_at', { count: 'exact' })
      .eq('workspace_id', wsId).gte('sent_at', since).lte('sent_at', asOf)
      .order('sent_at', { ascending: false }).order('id').range(f, t)),
  ])

  const truncated = [projectsQ, amendmentsQ, cosQ].some(q => q.truncated)
  const allProjects = projectsQ.rows as any[]
  const allAmendments = amendmentsQ.rows as any[]
  const allCos = cosQ.rows as any[]

  const currencyCounts: Record<string, number> = {}
  for (const p of allProjects) currencyCounts[p.currency || 'USD'] = (currencyCounts[p.currency || 'USD'] || 0) + 1
  const { availableCurrencies, mixedCurrencies, currency } = pickCurrency(currencyCounts, requestedCurrency)

  const projects = allProjects.filter(p => (p.currency || 'USD') === currency)
  const projectById = new Map(projects.map(p => [p.id, p]))
  const additive = allAmendments.filter(a => projectById.has(a.project_id) && !isNonAdditiveAmendment(a, projectById.get(a.project_id)?.type))
  const periodAmendments = additive.filter(a => a.created_at >= since)
  const cos = allCos.filter(c => projectById.has(c.project_id))

  const lifetimeByProject: Record<string, number> = {}
  for (const a of additive) lifetimeByProject[a.project_id] = (lifetimeByProject[a.project_id] || 0) + (Number(a.financial_impact) || 0)

  const effectiveOf = (p: any) => (Number(p.contract_value) || 0) + (lifetimeByProject[p.id] || 0)

  const baseValue = projects.reduce((s, p) => s + (Number(p.contract_value) || 0), 0)
  const lifetimeAmendments = additive.reduce((s, a) => s + (Number(a.financial_impact) || 0), 0)
  const coImpact = periodAmendments.reduce((s, a) => s + (Number(a.financial_impact) || 0), 0)

  const clientMap: Record<string, { client_id: string; client_name: string; value: number }> = {}
  for (const p of projects) {
    const cid = p.client_id
    if (!cid) continue
    if (!clientMap[cid]) clientMap[cid] = { client_id: cid, client_name: p.clients?.name || 'Unknown', value: 0 }
    clientMap[cid].value += effectiveOf(p)
  }

  const typeMap: Record<string, number> = {}
  for (const p of projects) typeMap[p.type] = (typeMap[p.type] || 0) + effectiveOf(p)

  const coGrid = buildCoGrid(cos)

  return {
    metrics: {
      // Point-in-time portfolio value (NOT period-filtered)…
      effective_value: baseValue + lifetimeAmendments,
      base_value:      baseValue,
      // …versus change-order value added inside the selected period.
      co_impact:       coImpact,
      cos_raised:      coGrid.raised,
      cos_accepted:    coGrid.accepted,
    },
    byClient: Object.values(clientMap).sort((a, b) => b.value - a.value),
    byType:   Object.entries(typeMap)
      .map(([type, value]) => ({ type, type_label: PROJECT_TYPE_LABELS[type] || type, value }))
      .sort((a, b) => b.value - a.value),
    coGrid,
    currency,
    mixedCurrencies,
    availableCurrencies,
    truncated,
  }
}
