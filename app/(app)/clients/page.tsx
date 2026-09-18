import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ClientsClient from '@/components/clients/ClientsClient'

export const metadata = { title: 'Clients' }

export default async function ClientsPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const service = createServiceClient()
  const { data: clients = [] } = await (service as any)
    .from('clients')
    .select(`id, name, company_name, email, phone, status, created_at,
      projects(id, status, contract_value, currency, deleted_at)`)
    .eq('workspace_id', session.workspaceId)
    .order('name')

  const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
  const canViewClientData = hasPermission(session, 'VIEW_CLIENT_DATA')

  // FIX (deep audit, section 14 — flagship finding): this page's projects
  // join had no project-level access filtering at all — every other place
  // projects are listed (app/(app)/projects/page.tsx, and the individual
  // project detail page) scopes them to VIEW_ALL_PROJECTS or explicit
  // project_members membership; this page ignored that entirely and
  // showed EVERY project for a client to any authenticated workspace
  // member. That meant "Projects: N" and "Total value: $X" on this list
  // were aggregated across projects a limited-access team member has no
  // membership on and couldn't otherwise open — a real information
  // disclosure, not a cosmetic one. Same fix shape as projects/page.tsx.
  const canViewAllProjects = hasPermission(session, 'VIEW_ALL_PROJECTS')
  let accessibleProjectIds: Set<string> | null = null
  if (!canViewAllProjects) {
    const { data: ids } = await (service as any)
      .from('project_members')
      .select('project_id, workspace_members!inner(user_id)')
      .eq('workspace_members.user_id', session.id)
    accessibleProjectIds = new Set((ids || []).map((r: { project_id: string }) => r.project_id))
  }

  // FIX (audit round 4, finding #3): this page shipped email, phone, and
  // per-project contract_value/currency into the initial RSC payload
  // unconditionally — ClientsClient.tsx only ever hid them in the
  // rendered DOM (`canViewClientData ? show : hide`), so the raw data
  // sat in the page source regardless of permission. Same fix already
  // applied to clients/[id]/page.tsx; redact at the source here too.
  const redacted = (clients || []).map((c: any) => ({
    ...c,
    email: canViewClientData ? c.email : null,
    phone: canViewClientData ? c.phone : null,
    // FIX (audit round 6): this join had no deleted_at filter, so
    // clientStats() on the list page counted soft-deleted projects while
    // the client detail page (which does filter .is('deleted_at', null))
    // correctly excludes them — the same client's project count/total
    // value could disagree between the two screens.
    projects: (canViewFinancials ? c.projects : (c.projects || []).map((p: any) => ({ ...p, contract_value: null })))
      .filter((p: any) => !p.deleted_at)
      .filter((p: any) => canViewAllProjects || accessibleProjectIds!.has(p.id)),
  }))

  return (
    <ClientsClient
      clients={redacted}
      canCreate={hasPermission(session, 'CREATE_PROJECTS')}
      canViewFinancials={canViewFinancials}
      canViewClientData={canViewClientData}
    />
  )
}
