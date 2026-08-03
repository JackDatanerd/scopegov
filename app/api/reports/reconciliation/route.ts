export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

// GET /api/reports/reconciliation?projectId=&days=90
// - With projectId: that project's latest snapshot + trend history (any
//   VIEW_FINANCIALS user who can see the project).
// - Without projectId: portfolio-aggregated latest snapshot across every
//   project, gated by VIEW_ALL_PROJECTS (same distinction Phase 2's
//   portfolio dashboard uses per BUG-058) so a member scoped to only their
//   own projects can't pull workspace-wide totals through this endpoint.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_FINANCIALS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId')
    const days       = Math.min(365, Math.max(1, Number(searchParams.get('days')) || 90))
    const service    = createServiceClient()
    const since       = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

    if (projectId) {
      const { data: project } = await (service as any)
        .from('projects').select('id, name, currency')
        .eq('id', projectId).eq('workspace_id', session.workspaceId).single()
      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

      const { data: history } = await (service as any)
        .from('contract_reconciliation_snapshots')
        .select('contracted_value, invoiced_to_date, paid_to_date, at_risk_value, snapshot_date')
        .eq('project_id', projectId)
        .gte('snapshot_date', since)
        .order('snapshot_date', { ascending: true })

      const latest = history && history.length ? history[history.length - 1] : null

      return NextResponse.json({
        scope: 'project',
        project: { id: project.id, name: project.name, currency: project.currency },
        latest,
        history: history || [],
      })
    }

    if (!hasPermission(session, 'VIEW_ALL_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_ALL_PROJECTS' }, { status: 403 })

    // Portfolio: latest snapshot per project, summed. Pull the most recent
    // `days` window and reduce client-side to "latest per project_id" +
    // a workspace-level daily total for the trend line.
    const { data: rows } = await (service as any)
      .from('contract_reconciliation_snapshots')
      .select('project_id, contracted_value, invoiced_to_date, paid_to_date, at_risk_value, snapshot_date, projects(name)')
      .eq('workspace_id', session.workspaceId)
      .gte('snapshot_date', since)
      .order('snapshot_date', { ascending: true })

    const latestByProject = new Map<string, any>()
    const totalsByDate = new Map<string, { contracted: number; invoiced: number; paid: number; atRisk: number }>()

    for (const r of (rows || [])) {
      latestByProject.set(r.project_id, r) // last write wins since ordered ascending
      const bucket = totalsByDate.get(r.snapshot_date) || { contracted: 0, invoiced: 0, paid: 0, atRisk: 0 }
      bucket.contracted += r.contracted_value || 0
      bucket.invoiced   += r.invoiced_to_date || 0
      bucket.paid        += r.paid_to_date || 0
      bucket.atRisk      += r.at_risk_value || 0
      totalsByDate.set(r.snapshot_date, bucket)
    }

    const projectsLatest = Array.from(latestByProject.values()).map((r: any) => ({
      projectId: r.project_id, projectName: r.projects?.name,
      contractedValue: r.contracted_value, invoicedToDate: r.invoiced_to_date,
      paidToDate: r.paid_to_date, atRiskValue: r.at_risk_value, snapshotDate: r.snapshot_date,
    }))

    const portfolioTotals = projectsLatest.reduce((acc, p) => ({
      contractedValue: acc.contractedValue + p.contractedValue,
      invoicedToDate:  acc.invoicedToDate + p.invoicedToDate,
      paidToDate:      acc.paidToDate + p.paidToDate,
      atRiskValue:     acc.atRiskValue + p.atRiskValue,
    }), { contractedValue: 0, invoicedToDate: 0, paidToDate: 0, atRiskValue: 0 })

    const trend = Array.from(totalsByDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, t]) => ({
        date, contractedValue: t.contracted, invoicedToDate: t.invoiced,
        paidToDate: t.paid, atRiskValue: t.atRisk,
      }))

    return NextResponse.json({
      scope: 'portfolio',
      totals: portfolioTotals,
      trend,
      projects: projectsLatest.sort((a, b) => b.atRiskValue - a.atRiskValue),
    })
  } catch (err) {
    console.error('Reconciliation report error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
