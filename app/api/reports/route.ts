import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { PROJECT_TYPE_LABELS } from '@/lib/utils/format'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
      const [flagsRes, exceptionsRes, adjustmentsRes, cosRes] = await Promise.all([
        (service as any).from('guardian_flags').select('id,status,projects(id,name)')
          .eq('workspace_id', wsId).gte('created_at', since),
        (service as any).from('exceptions_log').select('id,deliverable,estimated_value,projects(id,name)')
          .eq('workspace_id', wsId).gte('created_at', since),
        (service as any).from('scope_adjustments').select('id,deliverable,old_value,new_value,reason,adjusted_at,projects(id,name)')
          .eq('workspace_id', wsId).gte('adjusted_at', since).order('adjusted_at', { ascending: false }),
        (service as any).from('amendments').select('id,financial_impact')
          .eq('workspace_id', wsId).gte('created_at', since),
      ])

      const flags      = flagsRes.data || []
      const exceptions = exceptionsRes.data || []
      const adjustments = adjustmentsRes.data || []
      const amendments = cosRes.data || []

      // Aggregate flags by project
      const flagMap: Record<string, { project_id: string; project_name: string; flag_count: number }> = {}
      for (const f of flags) {
        const pid = f.projects?.id
        if (!pid) continue
        if (!flagMap[pid]) flagMap[pid] = { project_id: pid, project_name: f.projects.name, flag_count: 0 }
        flagMap[pid].flag_count++
      }

      const recoveredValue = amendments.reduce((s: number, a: any) => s + (a.financial_impact || 0), 0)

      return NextResponse.json({
        metrics: {
          total_flags:     flags.length,
          converted_to_co: flags.filter((f: any) => f.status === 'converted_to_co').length,
          recovered_value: canSeeFinancials ? recoveredValue : null,
        },
        flagsByProject:      Object.values(flagMap).sort((a, b) => b.flag_count - a.flag_count),
        exceptionsByProject: exceptions,
        adjustments,
        currency:            'USD',
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
      (service as any).from('change_orders').select('id,status,total')
        .eq('workspace_id', wsId).gte('created_at', since),
    ])

    const projects   = projectsRes.data || []
    const amendments = amendmentsRes.data || []
    const cos        = cosRes2.data || []

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

    const currency = projects[0]?.currency || 'USD'

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
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
