import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import ProjectsClient from '@/components/projects/ProjectsClient'

export const metadata = { title: 'Projects' }

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams
  const session = await getSession()
  if (!session) redirect('/login')

  const service = createServiceClient()
  const canViewAll = hasPermission(session, 'VIEW_ALL_PROJECTS')
  const canCreate = hasPermission(session, 'CREATE_PROJECTS')

  // BUG-058: two distinct query paths
  let query = (service as any)
    .from('projects')
    .select(`
      id, name, disc, type, status, stall_reason, contract_value, currency,
      start_date, created_at, updated_at, internal_ref,
      clients(id, name, company_name),
      guardian_flags(status, severity),
      change_orders(id, status, title, total),
      sow_documents(id, status, version, sent_at, signed_at)
    `)
    .eq('workspace_id', session.workspaceId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })

  if (!canViewAll) {
    // FIX: project_members has neither workspace_id nor user_id columns —
    // see app/api/projects/route.ts for the full explanation. This
    // silently returned nothing for anyone without VIEW_ALL_PROJECTS.
    const { data: ids } = await (service as any)
      .from('project_members')
      .select('project_id, workspace_members!inner(user_id)')
      .eq('workspace_members.user_id', session.id)
    const projectIds = (ids || []).map((r: { project_id: string }) => r.project_id)
    if (projectIds.length > 0) {
      query = query.in('id', projectIds)
    } else {
      return <EmptyProjects canCreate={canCreate} />
    }
  }

  const { data: projects = [] } = await query

  // FIX (fix round, Projects & Dashboard section 7): viewFinancials used to
  // only control what ProjectsClient (a Client Component) *rendered* —
  // contract_value and change_orders[].total were fetched here and passed
  // into it wholesale regardless of permission, so both travelled to the
  // browser in every RSC payload for a member without VIEW_FINANCIALS, same
  // as any other prop. Same class of bug already fixed on the project detail
  // page (app/(app)/projects/[id]/page.tsx's own comment describes it) and
  // on the Dashboard (a plain server component, so it never had this
  // exposure) — just missed here. Strip at the source instead of trusting
  // the client component to hide what it's already been given.
  const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
  const safeProjects = canViewFinancials
    ? projects
    : (projects || []).map((p: any) => ({
        ...p,
        contract_value: null,
        change_orders: Array.isArray(p.change_orders)
          ? p.change_orders.map((co: any) => ({ ...co, total: null }))
          : p.change_orders,
      }))

  // FIX (section-11/12 audit — flagship feature gap): see lib/utils/attention.ts
  // — mirrors the same pending-approvals fetch the Dashboard now does, so
  // both screens agree on which projects are stuck in an approval chain.
  // A separate query (not an embedded approval_requests(...) above) to
  // keep the pending-only filter from inner-joining out projects with zero
  // pending requests.
  // FIX (fix round, section-11 flagship finding): broadened to also match
  // an approved-but-send-failed request (status='approved', send_failed_at
  // set — migration 053), same reasoning as the Dashboard's matching fix —
  // that state is just as stuck as a pending decision, but never matched
  // status='pending' so it was invisible here.
  let pendingApprovalsQuery = (service as any)
    .from('approval_requests')
    .select('project_id, created_at, updated_at, send_failed_at')
    .eq('workspace_id', session.workspaceId)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
  if (!canViewAll) {
    const ids = (projects || []).map((p: any) => p.id)
    pendingApprovalsQuery = pendingApprovalsQuery.in('project_id', ids)
  }
  const { data: pendingApprovalRows = [] } = await pendingApprovalsQuery
  const pendingApprovalsByProject = new Map<string, Array<{ created_at: string; send_failed_at: string | null }>>()
  for (const r of (pendingApprovalRows || [])) {
    const list = pendingApprovalsByProject.get(r.project_id) || []
    // Last activity, not creation time — same clock the approval-stall cron uses.
    list.push({ created_at: r.updated_at || r.created_at, send_failed_at: r.send_failed_at })
    pendingApprovalsByProject.set(r.project_id, list)
  }
  const projectsWithApprovals = (safeProjects || []).map((p: any) => ({
    ...p, pending_approvals: pendingApprovalsByProject.get(p.id),
  }))

  // FIX (deep audit, section 7): fetch the workspace's actual Guardian
  // settings so "needs attention" here matches the Dashboard instead of
  // silently falling back to isAttentionWorthy's hardcoded defaults.
  const { data: ws } = await (service as any)
    .from('workspaces')
    .select('proactive_risk_alerts_enabled, proactive_risk_threshold, currency')
    .eq('id', session.workspaceId)
    .maybeSingle()

  return (
    <ProjectsClient
      projects={projectsWithApprovals}
      initialFilter={filter === 'attention' ? 'attention' : null}
      canCreate={canCreate}
      canViewFinancials={canViewFinancials}
      session={session}
      workspaceSettings={{
        proactiveRiskAlertsEnabled: ws?.proactive_risk_alerts_enabled,
        proactiveRiskThreshold: ws?.proactive_risk_threshold,
        currency: ws?.currency,
      }}
    />
  )
}

function EmptyProjects({ canCreate }: { canCreate: boolean }) {
  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">Manage all your client work</p>
        </div>
        {canCreate && (
          <Link href="/projects/new">
            <button className="btn btn-primary"><i className="ti ti-plus" style={{ fontSize: 13 }} /> New project</button>
          </Link>
        )}
      </div>
      <div className="surface">
        <div className="empty-state">
          <i className="ti ti-folder-open empty-state-icon" />
          <p className="empty-state-title">No projects yet</p>
          <p className="empty-state-sub">Create your first project to get started.</p>
          {canCreate && (
            <Link href="/projects/new">
              <button className="btn btn-primary"><i className="ti ti-plus" style={{ fontSize: 13 }} /> New project</button>
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
