import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import ProjectsClient from '@/components/projects/ProjectsClient'
import { isAttentionWorthy, attentionReason } from '@/lib/utils/attention'
import { effectiveContractValue, monthlyRetainerRate, loadRetainerMonthsBilled } from '@/lib/utils/contract-value'
import { loadUnreadMessageCounts } from '@/lib/utils/project-unread'

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
      id, name, disc, type, status, stall_reason, stalled_at, contract_value, retainer_duration_months, currency,
      start_date, created_at, updated_at, internal_ref,
      clients(id, name, company_name),
      guardian_flags(status, severity),
      change_orders(id, status, title, total),
      sow_documents(id, status, version, sent_at, signed_at),
      amendments(financial_impact, change_orders(is_retainer_renewal))
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

  const { data: projectRows = [] } = await query

  // Effective value = the shared definition (lib/utils/contract-value.ts): base — a retainer's monthly
  // rate × term — plus accepted change orders. The list used to show the stored base alone.
  const retainerMonths = await loadRetainerMonthsBilled(service, projectRows || [])
  const projects = (projectRows || []).map((p: any) => {
    const { amendments, ...rest } = p
    return { ...rest, effective_value: effectiveContractValue(p, amendments, retainerMonths.get(p.id)), monthly_rate: monthlyRetainerRate(p) }
  })

  const unreadByProject = await loadUnreadMessageCounts(service, session.id, projects.map((p: any) => p.id))

  // Pending approval requests, so a document stuck in an approval chain counts as "needs attention"
  // (same fetch and same broadened match — pending, or approved-but-send-failed — as the Dashboard).
  // A separate query rather than an embed: an embedded filter would inner-join away projects with none.
  let pendingApprovalsQuery = (service as any)
    .from('approval_requests')
    .select('project_id, created_at, updated_at, send_failed_at')
    .eq('workspace_id', session.workspaceId)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
  if (!canViewAll) pendingApprovalsQuery = pendingApprovalsQuery.in('project_id', projects.map((p: any) => p.id))
  const { data: pendingApprovalRows = [] } = await pendingApprovalsQuery
  const pendingApprovalsByProject = new Map<string, Array<{ createdAt: string; sendFailed: boolean }>>()
  for (const r of (pendingApprovalRows || [])) {
    const list = pendingApprovalsByProject.get(r.project_id) || []
    // Last activity, not creation time — same clock the approval-stall cron uses.
    list.push({ createdAt: r.updated_at || r.created_at, sendFailed: !!r.send_failed_at })
    pendingApprovalsByProject.set(r.project_id, list)
  }

  // The workspace's real Guardian settings, so "needs attention" matches the Dashboard.
  const { data: ws } = await (service as any)
    .from('workspaces')
    .select('proactive_risk_alerts_enabled, proactive_risk_threshold, currency')
    .eq('id', session.workspaceId)
    .maybeSingle()
  const workspaceSettings = {
    proactiveRiskAlertsEnabled: ws?.proactive_risk_alerts_enabled,
    proactiveRiskThreshold: ws?.proactive_risk_threshold,
    currency: ws?.currency,
  }

  // Attention is decided HERE, from the full (unstripped) data, and only the verdict is sent to the
  // browser. Deciding it in the client component meant a member without VIEW_FINANCIALS — whose
  // contract values are stripped below — got a different answer from the Dashboard for the same project
  // (the "high-value project, no signed SOW" rule needs the value).
  const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
  const safeProjects = projects.map((p: any) => {
    const attnProject = {
      ...p, contractValue: p.effective_value, stallReason: p.stall_reason, stalledAt: p.stalled_at,
      guardianFlags: p.guardian_flags, changeOrders: p.change_orders, sowDocuments: p.sow_documents,
      pendingApprovals: pendingApprovalsByProject.get(p.id),
    }
    const needsAttention = isAttentionWorthy({ project: attnProject, workspace: workspaceSettings })
    const { stalled_at: _stalledAt, ...rest } = p
    const base = {
      ...rest,
      needs_attention: needsAttention,
      unread_messages: unreadByProject.get(p.id) || 0,
      attention_reason: needsAttention ? attentionReason({ project: attnProject }) : null,
    }
    // Strip financials at the source (they'd otherwise travel to the browser in the RSC payload).
    return canViewFinancials ? base : {
      ...base,
      contract_value: null, effective_value: null, monthly_rate: null,
      change_orders: Array.isArray(p.change_orders)
        ? p.change_orders.map((co: any) => ({ ...co, total: null }))
        : p.change_orders,
    }
  })

  return (
    <ProjectsClient
      projects={safeProjects}
      initialFilter={filter === 'attention' ? 'attention' : null}
      canCreate={canCreate}
      canViewFinancials={canViewFinancials}
      session={session}
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
