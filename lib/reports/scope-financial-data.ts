// lib/reports/scope-financial-data.ts
//
// FEATURE (deep audit, Reports & Audit re-pass): this used to live inline
// inside app/api/reports/route.ts. Pulled out unchanged (bugs and all —
// see the FIX comments still attached to the currency-bucketing logic
// below) so app/api/reports/export/route.ts can compute the identical
// scope/financial payload instead of hand-rolling a second copy of these
// queries that could silently drift from the on-screen numbers.

import { PROJECT_TYPE_LABELS } from '@/lib/utils/format'

export type ReportMode = 'scope' | 'financial'

const PERIOD_DAYS: Record<string, number | null> = {
  '30d': 30, '90d': 90, '6m': 180, '12m': 365, 'all': null,
}

export function periodSince(period: string): string {
  const days = PERIOD_DAYS[period]
  return days ? new Date(Date.now() - days * 86400000).toISOString() : '2000-01-01T00:00:00Z'
}

export const PERIOD_LABELS: Record<string, string> = {
  '30d': 'Last 30 days', '90d': 'Last 90 days', '6m': 'Last 6 months', '12m': 'Last 12 months', 'all': 'All time',
}

export async function getScopeReportData(
  service: any, wsId: string, since: string, requestedCurrency: string | null, canSeeFinancials: boolean
) {
  const [flagsRes, exceptionsRes, adjustmentsRes, cosRes, projCurrencyRes] = await Promise.all([
    service.from('guardian_flags').select('id,status,projects(id,name)')
      .eq('workspace_id', wsId).gte('created_at', since),
    service.from('exceptions_log').select('id,deliverable,estimated_value,project_id,projects(id,name,currency)')
      .eq('workspace_id', wsId).gte('created_at', since),
    service.from('scope_adjustments').select('id,deliverable,old_value,new_value,reason,adjusted_at,project_id,projects(id,name)')
      .eq('workspace_id', wsId).gte('adjusted_at', since).order('adjusted_at', { ascending: false }),
    service.from('amendments').select('id,financial_impact,project_id')
      .eq('workspace_id', wsId).gte('created_at', since),
    service.from('projects').select('id,currency').eq('workspace_id', wsId).is('deleted_at', null),
  ])

  const flags      = flagsRes.data || []
  const exceptions = exceptionsRes.data || []
  const allAdjustments = adjustmentsRes.data || []
  const allAmendments = cosRes.data || []
  const projCurrencyById: Record<string, string> = {}
  for (const p of (projCurrencyRes.data || [])) projCurrencyById[p.id] = p.currency || 'USD'

  const currencyCounts: Record<string, number> = {}
  for (const c of Object.values(projCurrencyById)) currencyCounts[c] = (currencyCounts[c] || 0) + 1
  const availableCurrencies = Object.keys(currencyCounts).sort()
  const mixedCurrencies = availableCurrencies.length > 1
  const currency = (requestedCurrency && availableCurrencies.includes(requestedCurrency))
    ? requestedCurrency
    : (availableCurrencies.sort((a, b) => currencyCounts[b] - currencyCounts[a])[0] || 'USD')

  // A project missing from projCurrencyById (soft-deleted, or otherwise
  // gone) should never match ANY selected currency — see the FIX comment
  // in api/reports/route.ts for the full history of this one.
  const NO_CURRENCY = '__no_active_project__'
  const amendments = allAmendments.filter((a: any) => (projCurrencyById[a.project_id] ?? NO_CURRENCY) === currency)
  const exceptionsInCurrency = exceptions.filter((e: any) => (projCurrencyById[e.project_id] ?? NO_CURRENCY) === currency)
  const recoveredValue = amendments.reduce((s: number, a: any) => s + (a.financial_impact || 0), 0)

  const flagsInCurrency = flags.filter((f: any) => (projCurrencyById[f.projects?.id] ?? NO_CURRENCY) === currency)
  const flagMapInCurrency: Record<string, { project_id: string; project_name: string; flag_count: number }> = {}
  for (const f of flagsInCurrency) {
    const pid = f.projects?.id
    if (!pid) continue
    if (!flagMapInCurrency[pid]) flagMapInCurrency[pid] = { project_id: pid, project_name: f.projects.name, flag_count: 0 }
    flagMapInCurrency[pid].flag_count++
  }

  const adjustmentsInCurrency = allAdjustments.filter((a: any) => (projCurrencyById[a.project_id] ?? NO_CURRENCY) === currency)

  return {
    metrics: {
      total_flags:     flagsInCurrency.length,
      converted_to_co: flagsInCurrency.filter((f: any) => f.status === 'converted_to_co').length,
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
  }
}

export async function getFinancialReportData(
  service: any, wsId: string, since: string, requestedCurrency: string | null
) {
  const [projectsRes, amendmentsRes, cosRes2] = await Promise.all([
    service.from('projects').select('id,name,type,contract_value,currency,client_id,clients(id,name)')
      .eq('workspace_id', wsId).is('deleted_at', null).neq('status', 'Draft').neq('status', 'Archived'),
    service.from('amendments').select('id,financial_impact,project_id')
      .eq('workspace_id', wsId).gte('created_at', since),
    service.from('change_orders').select('id,status,total,project_id')
      .eq('workspace_id', wsId).gte('created_at', since),
  ])

  const allProjects = projectsRes.data || []
  const allAmendments = amendmentsRes.data || []
  const allCos      = cosRes2.data || []

  const currencyCounts: Record<string, number> = {}
  for (const p of allProjects) currencyCounts[p.currency || 'USD'] = (currencyCounts[p.currency || 'USD'] || 0) + 1
  const availableCurrencies = Object.keys(currencyCounts).sort()
  const mixedCurrencies = availableCurrencies.length > 1

  const currency = (requestedCurrency && availableCurrencies.includes(requestedCurrency))
    ? requestedCurrency
    : (availableCurrencies.sort((a, b) => currencyCounts[b] - currencyCounts[a])[0] || 'USD')

  const projects   = allProjects.filter((p: any) => (p.currency || 'USD') === currency)
  const projectIds = new Set(projects.map((p: any) => p.id))
  const amendments = allAmendments.filter((a: any) => projectIds.has(a.project_id))
  const cos        = allCos.filter((c: any) => projectIds.has(c.project_id))

  const baseValue = projects.reduce((s: number, p: any) => s + (p.contract_value || 0), 0)
  const coImpact  = amendments.reduce((s: number, a: any) => s + (a.financial_impact || 0), 0)

  const clientMap: Record<string, { client_id: string; client_name: string; value: number }> = {}
  for (const p of projects) {
    const cid = p.client_id
    if (!cid) continue
    if (!clientMap[cid]) clientMap[cid] = { client_id: cid, client_name: p.clients?.name || 'Unknown', value: 0 }
    clientMap[cid].value += p.contract_value || 0
  }

  const typeMap: Record<string, number> = {}
  for (const p of projects) {
    typeMap[p.type] = (typeMap[p.type] || 0) + (p.contract_value || 0)
  }

  return {
    metrics: {
      effective_value: baseValue + coImpact,
      co_impact:       coImpact,
      cos_raised:      cos.length,
      cos_accepted:    cos.filter((c: any) => c.status === 'accepted').length,
    },
    byClient: Object.values(clientMap).sort((a, b) => b.value - a.value),
    byType:   Object.entries(typeMap)
      .map(([type, value]) => ({ type, type_label: PROJECT_TYPE_LABELS[type] || type, value }))
      .sort((a, b) => b.value - a.value),
    coGrid: {
      raised:   cos.length,
      accepted: cos.filter((c: any) => c.status === 'accepted').length,
      declined: cos.filter((c: any) => c.status === 'declined').length,
      pending:  cos.filter((c: any) => ['awaiting_response', 'countered', 'stalled'].includes(c.status)).length,
    },
    currency,
    mixedCurrencies,
    availableCurrencies,
  }
}
