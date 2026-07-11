import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import ProjectDetail from '@/components/projects/ProjectDetail'

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; new?: string }>
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params
  const service = createServiceClient()
  const { data: p } = await (service as any)
    .from('projects').select('name').eq('id', id).single()
  return { title: p?.name || 'Project' }
}

export default async function ProjectPage({ params, searchParams }: Props) {
  const { id } = await params
  const { tab = 'overview', new: isNew } = await searchParams
  const session = await getSession()
  if (!session) redirect('/login')

  const service = createServiceClient()

  // ── Fetch project ─────────────────────────────────────────────────────
  const { data: project } = await (service as any)
    .from('projects')
    .select(`
      id, name, disc, type, status, stall_reason, contract_value, currency,
      start_date, internal_ref, retainer_duration_months, created_at, updated_at,
      client_id, created_by, workspace_id, guardian_email,
      clients(id, name, company_name, email, cc_emails, phone, notes),
      guardian_flags(id, status, severity, description, sow_reference, type, created_at, change_order_id, escalated_to),
      change_orders(id, title, status, total, sent_at, accepted_at, version),
      sow_documents(id, version, status, sent_at, signed_at, created_at),
      project_scope_snapshot(id, deliverables, out_of_scope, last_updated_at)
    `)
    .eq('id', id)
    .eq('workspace_id', session.workspaceId)
    .is('deleted_at', null)
    .single()

  if (!project) notFound()

  // Check project access (own projects check)
  const canViewAll = hasPermission(session, 'VIEW_ALL_PROJECTS')
  if (!canViewAll) {
    const { data: membership } = await (service as any)
      .from('project_members')
      .select('id')
      .eq('project_id', id)
      .eq('user_id', session.id)
      .single()
    if (!membership) notFound()
  }

  // ── Fetch payment milestones ──────────────────────────────────────────
  const { data: milestones = [] } = await (service as any)
    .from('payment_milestones')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: true })

  // ── Fetch amendments ──────────────────────────────────────────────────
  const { data: amendments = [] } = await (service as any)
    .from('amendments')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: true })

  // ── Fetch team members ────────────────────────────────────────────────
  const { data: team = [] } = await (service as any)
    .from('project_members')
    .select('id, added_at, workspace_members(id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email, avatar_url))')
    .eq('project_id', id)

  // ── Fetch activity ────────────────────────────────────────────────────
  const { data: activity = [] } = await (service as any)
    .from('audit_log')
    .select('id, event_type, entity_name, actor_name, actor_email, created_at, metadata')
    .eq('entity_id', id)
    .eq('workspace_id', session.workspaceId)
    .order('created_at', { ascending: false })
    .limit(50)

  // Effective contract value
  const amendmentTotal = (amendments || []).reduce(
    (s: number, a: any) => s + (a.financial_impact || 0), 0
  )
  const effectiveContractValue = (project.contract_value || 0) + amendmentTotal

  return (
    <ProjectDetail
      project={project}
      milestones={milestones || []}
      amendments={amendments || []}
      team={team || []}
      activity={activity || []}
      effectiveContractValue={effectiveContractValue}
      initialTab={tab}
      isNewProject={isNew === '1'}
      session={session}
      permissions={{
        editSow: hasPermission(session, 'EDIT_SOW'),
        sendSow: hasPermission(session, 'SEND_SOW'),
        createCo: hasPermission(session, 'CREATE_CHANGE_ORDERS'),
        sendCo: hasPermission(session, 'SEND_CHANGE_ORDERS'),
        approveFlags: hasPermission(session, 'APPROVE_FLAGS'),
        grantExceptions: hasPermission(session, 'GRANT_EXCEPTIONS'),
        markComplete: hasPermission(session, 'MARK_PROJECT_COMPLETE'),
        markDeliverable: hasPermission(session, 'MARK_DELIVERABLE_STATUS'),
        markMilestone: hasPermission(session, 'MARK_PAYMENT_MILESTONES'),
        submitGuardian: hasPermission(session, 'SUBMIT_GUARDIAN_CHECKS'),
        viewGuardianHistory: hasPermission(session, 'ACCESS_GUARDIAN_HISTORY'),
        assignTeam: hasPermission(session, 'ASSIGN_TEAM_MEMBERS'),
        viewFinancials: hasPermission(session, 'VIEW_FINANCIALS'),
        deleteProject: hasPermission(session, 'DELETE_PROJECTS'),
      }}
    />
  )
}
