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
      change_orders(id, title, status, total, sent_at, accepted_at, version, document_number),
      sow_documents(id, version, status, sent_at, signed_at, created_at, document_number),
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
    // FIX: project_members has no user_id column — it links to
    // workspace_members via member_id, which links to users via user_id.
    // The old query filtered directly on a nonexistent project_members.user_id,
    // which errored on every call, so this check always failed and anyone
    // without VIEW_ALL_PROJECTS got notFound() on every project, including
    // ones they were legitimately assigned to.
    const { data: membership } = await (service as any)
      .from('project_members')
      .select('id, workspace_members!inner(user_id)')
      .eq('project_id', id)
      .eq('workspace_members.user_id', session.id)
      .maybeSingle()
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

  // ── Fetch invoices (Phase 4a) ────────────────────────────────────────
  const { data: invoices = [] } = await (service as any)
    .from('invoices')
    .select('id, milestone_id, sow_id, co_id, invoice_number, title, amount, amount_paid, currency, status, due_date, sent_at, paid_at, voided_at, token, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: false })

  // ── Fetch reconciliation snapshot history (Phase 4) ──────────────────
  const { data: reconciliation = [] } = await (service as any)
    .from('contract_reconciliation_snapshots')
    .select('contracted_value, invoiced_to_date, paid_to_date, at_risk_value, snapshot_date')
    .eq('project_id', id)
    .order('snapshot_date', { ascending: true })
    .limit(90)

  // Effective contract value
  const amendmentTotal = (amendments || []).reduce(
    (s: number, a: any) => s + (a.financial_impact || 0), 0
  )
  const effectiveContractValue = (project.contract_value || 0) + amendmentTotal

  // ── Fetch in-flight approval requests (Phase 3) ─────────────────────────
  // Keyed by "sow:<id>" / "co:<id>" so ProjectDetail can look one up per
  // document without a join — a SOW/CO's status stays 'draft' while an
  // approval chain is pending, so this is the only signal the UI has that
  // a draft is actually "sent for approval" rather than just untouched.
  const { data: pendingApprovalRows = [] } = await (service as any)
    .from('approval_requests')
    .select('id, document_type, document_id, current_step, total_steps')
    .eq('project_id', id)
    .eq('status', 'pending')

  const pendingApprovals: Record<string, { id: string; current_step: number; total_steps: number }> = {}
  for (const r of pendingApprovalRows || []) {
    pendingApprovals[`${r.document_type}:${r.document_id}`] = {
      id: r.id, current_step: r.current_step, total_steps: r.total_steps,
    }
  }

  return (
    <ProjectDetail
      project={project}
      milestones={milestones || []}
      amendments={amendments || []}
      team={team || []}
      activity={activity || []}
      invoices={invoices || []}
      reconciliation={reconciliation || []}
      effectiveContractValue={effectiveContractValue}
      initialTab={tab}
      isNewProject={isNew === '1'}
      session={session}
      pendingApprovals={pendingApprovals}
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
        sendInvoices: hasPermission(session, 'SEND_INVOICES'),
      }}
    />
  )
}
