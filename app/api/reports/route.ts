import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { PROJECT_TYPE_LABELS } from '@/lib/utils/format'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // FIX (audit round 5): both modes below are workspace-wide rollups —
    // scope mode aggregates flags/exceptions/adjustments/amendments across
    // EVERY project in the workspace, financial mode does the same for
    // contract value/CO totals. /api/reports/portfolio and the portfolio
    // branch of /api/reports/reconciliation already require
    // VIEW_ALL_PROJECTS for exactly this reason (see their comments) —
    // this route was the one place that rollup logic existed without the
    // same gate, so a VIEW_OWN_PROJECTS-only member could pull scope and
    // financial data for projects they aren't assigned to.
    if (!hasPermission(session, 'VIEW_ALL_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_ALL_PROJECTS' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const mode   = searchParams.get('mode') || 'scope'
    const period = searchParams.get('period') || '90d'

    const service = createServiceClient()

    // Period filter
    const periodDays: Record<string, number | null> = {
      '30d': 30, '90d': 90, '6m': 180, '12m': 365, 'all': null,
    }
    const days = periodDays[period]
    const since = days
      ? new Date(Date.now() - days * 86400000).toISOString()
      : '2000-01-01T00:00:00Z'

    const wsId = session.workspaceId
    const canSeeFinancials = hasPermission(session, 'VIEW_FINANCIALS')

    if (mode === 'scope') {
      const [flagsRes, exceptionsRes, adjustmentsRes, cosRes, projCurrencyRes] = await Promise.all([
        (service as any).from('guardian_flags').select('id,status,projects(id,name)')
          .eq('workspace_id', wsId).gte('created_at', since),
        (service as any).from('exceptions_log').select('id,deliverable,estimated_value,project_id,projects(id,name,currency)')
          .eq('workspace_id', wsId).gte('created_at', since),
        (service as any).from('scope_adjustments').select('id,deliverable,old_value,new_value,reason,adjusted_at,projects(id,name)')
          .eq('workspace_id', wsId).gte('adjusted_at', since).order('adjusted_at', { ascending: false }),
        (service as any).from('amendments').select('id,financial_impact,project_id')
          .eq('workspace_id', wsId).gte('created_at', since),
        (service as any).from('projects').select('id,currency').eq('workspace_id', wsId).is('deleted_at', null),
      ])

      const flags      = flagsRes.data || []
      const exceptions = exceptionsRes.data || []
      const adjustments = adjustmentsRes.data || []
      const allAmendments = cosRes.data || []
      const projCurrencyById: Record<string, string> = {}
      for (const p of (projCurrencyRes.data || [])) projCurrencyById[p.id] = p.currency || 'USD'

      // Aggregate flags by project
      const flagMap: Record<string, { project_id: string; project_name: string; flag_count: number }> = {}
      for (const f of flags) {
        const pid = f.projects?.id
        if (!pid) continue
        if (!flagMap[pid]) flagMap[pid] = { project_id: pid, project_name: f.projects.name, flag_count: 0 }
        flagMap[pid].flag_count++
      }

      // FIX: recovered_value and exception totals were summed across every
      // project's currency with a hardcoded 'USD' label — same bug as
      // financial mode. Filter to one currency at a time here too.
      const currencyCounts: Record<string, number> = {}
      for (const c of Object.values(projCurrencyById)) currencyCounts[c] = (currencyCounts[c] || 0) + 1
      const availableCurrencies = Object.keys(currencyCounts).sort()
      const mixedCurrencies = availableCurrencies.length > 1
      const requestedCurrency = searchParams.get('currency')
      const currency = (requestedCurrency && availableCurrencies.includes(requestedCurrency))
        ? requestedCurrency
        : (availableCurrencies.sort((a, b) => currencyCounts[b] - currencyCounts[a])[0] || 'USD')

      const amendments = allAmendments.filter((a: any) => (projCurrencyById[a.project_id] || 'USD') === currency)
      const exceptionsInCurrency = exceptions.filter((e: any) => (e.projects?.currency || 'USD') === currency)
      const recoveredValue = amendments.reduce((s: number, a: any) => s + (a.financial_impact || 0), 0)

      return NextResponse.json({
        metrics: {
          total_flags:     flags.length,
          converted_to_co: flags.filter((f: any) => f.status === 'converted_to_co').length,
          recovered_value: canSeeFinancials ? recoveredValue : null,
        },
        flagsByProject:      Object.values(flagMap).sort((a, b) => b.flag_count - a.flag_count),
        exceptionsByProject: exceptionsInCurrency,
        adjustments,
        currency,
        mixedCurrencies,
        availableCurrencies,
      })
    }

    // ── Financial mode ────────────────────────────────────────
    if (!canSeeFinancials)
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })

    const [projectsRes, amendmentsRes, cosRes2] = await Promise.all([
      (service as any).from('projects').select('id,name,type,contract_value,currency,client_id,clients(id,name)')
        .eq('workspace_id', wsId).is('deleted_at', null).not('status', 'in', '("Draft","Archived")'),
      (service as any).from('amendments').select('id,financial_impact,project_id')
        .eq('workspace_id', wsId).gte('created_at', since),
      (service as any).from('change_orders').select('id,status,total,project_id')
        .eq('workspace_id', wsId).gte('created_at', since),
    ])

    const allProjects = projectsRes.data || []
    const allAmendments = amendmentsRes.data || []
    const allCos      = cosRes2.data || []

    // FIX: this used to sum contract_value across every project regardless
    // of currency, then slapped an arbitrary single currency label
    // (projects[0]'s) on the blended total — e.g. USD + KES + GBP added
    // together and reported as "USD X". No conversion was ever applied.
    // Doing real FX conversion correctly (live rates, caching, historical
    // accuracy for past periods) is a real feature to build deliberately,
    // not a one-line fix — so instead: never blend. Filter to one currency
    // at a time, and tell the frontend when there's more than one so it
    // can offer a selector, rather than silently producing a wrong number.
    const currencyCounts: Record<string, number> = {}
    for (const p of allProjects) currencyCounts[p.currency || 'USD'] = (currencyCounts[p.currency || 'USD'] || 0) + 1
    const availableCurrencies = Object.keys(currencyCounts).sort()
    const mixedCurrencies = availableCurrencies.length > 1

    const requestedCurrency = searchParams.get('currency')
    const currency = (requestedCurrency && availableCurrencies.includes(requestedCurrency))
      ? requestedCurrency
      : (availableCurrencies.sort((a, b) => currencyCounts[b] - currencyCounts[a])[0] || 'USD')

    const projects   = allProjects.filter((p: any) => (p.currency || 'USD') === currency)
    const projectIds = new Set(projects.map((p: any) => p.id))
    const amendments = allAmendments.filter((a: any) => projectIds.has(a.project_id))
    const cos        = allCos.filter((c: any) => projectIds.has(c.project_id))

    const baseValue = projects.reduce((s: number, p: any) => s + (p.contract_value || 0), 0)
    const coImpact  = amendments.reduce((s: number, a: any) => s + (a.financial_impact || 0), 0)

    // By client
    const clientMap: Record<string, { client_id: string; client_name: string; value: number }> = {}
    for (const p of projects) {
      const cid = p.client_id
      if (!cid) continue
      if (!clientMap[cid]) clientMap[cid] = { client_id: cid, client_name: p.clients?.name || 'Unknown', value: 0 }
      clientMap[cid].value += p.contract_value || 0
    }

    // By type
    const typeMap: Record<string, number> = {}
    for (const p of projects) {
      typeMap[p.type] = (typeMap[p.type] || 0) + (p.contract_value || 0)
    }

    return NextResponse.json({
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
        pending:  cos.filter((c: any) => ['awaiting_response','countered','stalled'].includes(c.status)).length,
      },
      currency,
      mixedCurrencies,
      availableCurrencies,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
