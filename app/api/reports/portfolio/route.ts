import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

// Portfolio dashboard is workspace-wide by definition — it has no
// per-project scoping, so it requires VIEW_ALL_PROJECTS outright rather
// than falling back to a VIEW_OWN_PROJECTS-filtered view (BUG-058's
// distinction doesn't apply here; there's no "own" portfolio).
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_ALL_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_ALL_PROJECTS' }, { status: 403 })

    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
    const { searchParams } = new URL(request.url)
    const period = searchParams.get('period') || '90d'
    const periodDays: Record<string, number> = { '30d': 30, '90d': 90, '6m': 180, '12m': 365 }
    const days = periodDays[period] ?? 90

    const service = createServiceClient()
    const wsId = session.workspaceId

    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

    const { data: snapshots } = await (service as any)
      .from('scope_health_snapshots')
      .select('snapshot_date, open_flags_count, open_flags_by_severity, exceptions_count, exceptions_value_total, contract_value_at_risk, stalled_sow_count, stalled_co_count, active_project_count, currency')
      .eq('workspace_id', wsId)
      .gte('snapshot_date', since)
      .order('snapshot_date', { ascending: true })

    const history = snapshots || []
    const latest = history.length ? history[history.length - 1] : null
    const earliest = history.length ? history[0] : null

    // Drill-down: current open flags across the whole portfolio, newest first.
    const { data: openFlags } = await (service as any)
      .from('guardian_flags')
      .select('id, severity, description, sow_reference, created_at, project_id, projects(id, name, contract_value, currency, clients(name))')
      .eq('workspace_id', wsId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(100)

    // Drill-down: stalled documents.
    const [stalledSowsRes, stalledCosRes] = await Promise.all([
      (service as any).from('projects')
        .select('id, name, updated_at, clients(name)')
        .eq('workspace_id', wsId).eq('status', 'Stalled').eq('stall_reason', 'sow_unsigned')
        .order('updated_at', { ascending: true }),
      (service as any).from('change_orders')
        .select('id, title, total, project_id, updated_at, projects(id, name)')
        .eq('workspace_id', wsId).eq('status', 'stalled')
        .order('updated_at', { ascending: true }),
    ])

    // Movement vs the start of the selected period, so the dashboard can
    // show a trend arrow, not just a static count.
    const trend = earliest && latest ? {
      openFlagsDelta: latest.open_flags_count - earliest.open_flags_count,
      atRiskDelta: Math.round((latest.contract_value_at_risk - earliest.contract_value_at_risk) * 100) / 100,
    } : null

    return NextResponse.json({
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
        projectId: c.project_id, projectName: c.projects?.name || 'Unknown project', since: c.updated_at,
      })),
      hasSnapshots: history.length > 0,
    })
  } catch (err) {
    console.error('Portfolio report error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
