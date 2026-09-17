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
  // FIX (deep audit, section 7 — cross-tenant leak): this ran with no
  // session check and no workspace filter at all, unlike the page
  // component below (which checks both). Any request for
  // /projects/<uuid> — authenticated or not, any workspace — leaked that
  // project's name via the page <title>, independent of whether the page
  // body then redirected or 404'd. Scope it exactly like the page does.
  const session = await getSession()
  if (!session) return { title: 'Project' }
  const service = createServiceClient()
  const { data: p } = await (service as any)
    .from('projects').select('name').eq('id', id).eq('workspace_id', session.workspaceId).single()
  return { title: p?.name || 'Project' }
}

export default async function ProjectPage({ params, searchParams }: Props) {
  const { id } = await params
  const { tab = 'overview', new: isNew } = await searchParams
  const session = await getSession()
  if (!session) redirect('/login')

  const service = createServiceClient()

  // ── Fetch project ─────────────────────────────────────────────────────
  // FIX (deep audit, section 7 — flagship finding): this select's inline
  // documentation had been pasted *inside* the template literal instead of
  // above it, so the "// FIX (section-10 audit, 10-G1): ..." comment lines
  // were sent to PostgREST as literal characters of the select= query
  // string, not stripped as a JS comment. That string isn't valid select
  // syntax, so the query failed on every single request, `project` came
  // back null, and `if (!project) notFound()` below fired unconditionally
  // — every project's detail page 404'd for every user. Moved the comment
  // back above the query (kept verbatim below) and confirmed the select
  // string is now a single clean template literal with no embedded prose.
  //
  // The original 10-G1 finding this was documenting: counter_amount/
  // counter_note were written by the client portal and read by the
  // accept-counter route — but appeared in NO component anywhere. The CO
  // card rendered a primary "Accept counter" button next to the ORIGINAL
  // total, so the agency was accepting a negotiated figure it had never
  // been shown, and the client's reasoning was nowhere in the product.
  // Fetch them so the card can show what's being accepted.
  // FIX (section-12 audit, flagship finding): tax_rate/tax_inclusive
  // weren't selected on change_orders here at all, so BillingTab's "bill
  // against this CO" picker had no way to carry an accepted CO's own tax
  // terms onto the invoice, even if it wanted to — see the matching fix
  // in components/invoices/BillingTab.tsx's pickSource().
  const { data: project } = await (service as any)
    .from('projects')
    .select(`
      id, name, disc, type, status, stall_reason, contract_value, currency,
      start_date, internal_ref, retainer_duration_months, created_at, updated_at,
      client_id, created_by, workspace_id, guardian_email,
      clients(id, name, company_name, email, cc_emails, phone, notes),
      guardian_flags(id, status, severity, description, sow_reference, type, created_at, change_order_id, escalated_to),
      change_orders(id, title, status, total, sent_at, accepted_at, version, document_number,
        counter_amount, counter_note, declined_reason, close_reason, tax_rate, tax_inclusive),
      sow_documents(id, version, status, sent_at, signed_at, created_at, document_number),
      project_scope_snapshot(id, deliverables, out_of_scope, last_updated_at)
    `)
    // FIX (re-audit, "current SOW" finding): the sow_documents/change_orders
    // embeds had no explicit order, so PostgREST returned them in whatever
    // order the underlying scan happened to produce — not guaranteed to be
    // version order. ProjectDetail's SowTab does `sows[0]` to decide which
    // SOW the Edit/Send/Withdraw/Remind buttons act on; without this, that
    // could silently be a stale/withdrawn version instead of the live one.
    .order('version', { ascending: false, foreignTable: 'sow_documents' })
    .order('version', { ascending: false, foreignTable: 'change_orders' })
    .eq('id', id)
    .eq('workspace_id', session.workspaceId)
    .is('deleted_at', null)
    .single()

  if (!project) notFound()

  // FIX (re-audit, cosmetic-gate finding): viewFinancials/viewClientData
  // used to only control what the *client component* rendered, while the
  // server component fetched and shipped the raw data to the browser in
  // every RSC payload regardless of permission — same class of bug as the
  // clients/[id] page already guards against with canViewClientData. Now
  // computed up front so both the DB fetches below and the project object
  // itself can actually withhold the data, not just hide it in the UI.
  const viewFinancials  = hasPermission(session, 'VIEW_FINANCIALS')
  const viewClientData  = hasPermission(session, 'VIEW_CLIENT_DATA')

  if (!viewFinancials) {
    project.contract_value = null
    if (Array.isArray(project.change_orders)) {
      // counter_amount is financial data on the same footing as total —
      // withhold it from the same people (10-G1).
      project.change_orders = project.change_orders.map((co: any) => ({ ...co, total: null, counter_amount: null }))
    }
  }
  if (!viewClientData && project.clients) {
    const { id: clientId, name } = project.clients
    project.clients = { id: clientId, name } // strip email, cc_emails, phone, notes
  }

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
  // FIX (re-audit): gated behind viewFinancials — was fetched unconditionally
  // and shipped to the client regardless of permission.
  const { data: milestones = [] } = viewFinancials
    ? await (service as any)
        .from('payment_milestones')
        .select('*')
        .eq('project_id', id)
        .order('created_at', { ascending: true })
    : { data: [] }

  // ── Fetch amendments ──────────────────────────────────────────────────
  const { data: amendmentsRaw = [] } = await (service as any)
    .from('amendments')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: true })

  // financial_impact is a dollar figure — redact it the same way as the
  // rest of the financial surface when the viewer lacks VIEW_FINANCIALS.
  const amendments = viewFinancials
    ? amendmentsRaw
    : (amendmentsRaw || []).map((a: any) => ({ ...a, financial_impact: null }))

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
  // FIX (re-audit): gated behind viewFinancials, same as milestones above.
  const { data: invoices = [] } = viewFinancials
    ? await (service as any)
        .from('invoices')
        .select('id, milestone_id, sow_id, co_id, invoice_number, title, amount, amount_paid, currency, status, due_date, sent_at, paid_at, voided_at, token, created_at')
        .eq('project_id', id)
        .order('created_at', { ascending: false })
    : { data: [] }

  // ── Fetch reconciliation snapshot history (Phase 4) ──────────────────
  const { data: reconciliation = [] } = viewFinancials
    ? await (service as any)
        .from('contract_reconciliation_snapshots')
        .select('contracted_value, invoiced_to_date, paid_to_date, at_risk_value, snapshot_date')
        .eq('project_id', id)
        .order('snapshot_date', { ascending: true })
        .limit(90)
    : { data: [] }

  // Effective contract value — financial_impact/contract_value are both
  // financial figures, so this derived total is withheld the same way.
  const amendmentTotal = (amendments || []).reduce(
    (s: number, a: any) => s + (a.financial_impact || 0), 0
  )
  const effectiveContractValue = viewFinancials
    ? (project.contract_value || 0) + amendmentTotal
    : null

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

  // FIX (doc-completeness audit): workspace.default_payment_instructions
  // was set in Settings but never read anywhere — the new-invoice form
  // always started blank. Fetch it so BillingTab can prefill.
  const { data: workspaceBilling } = await (service as any)
    .from('workspaces')
    .select('default_payment_instructions')
    .eq('id', session.workspaceId)
    .single()

  return (
    <ProjectDetail
      project={project}
      milestones={milestones || []}
      amendments={amendments || []}
      team={team || []}
      activity={activity || []}
      invoices={invoices || []}
      reconciliation={reconciliation || []}
      defaultPaymentInstructions={workspaceBilling?.default_payment_instructions || ''}
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
        // FIX (deep audit, section 7): DELETE /api/projects/[id]/messages/
        // [messageId] already lets an admin (MANAGE_WORKSPACE_SETTINGS)
        // delete anyone's message — moderation of a stray/inappropriate
        // post shouldn't require a database console — but no permission
        // for it ever reached the frontend, so the Discussion tab never
        // showed a delete affordance for anything but the author's own
        // messages.
        moderateMessages: hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'),
      }}
    />
  )
}
