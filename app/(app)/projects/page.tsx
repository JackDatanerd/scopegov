import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import ProjectsClient from '@/components/projects/ProjectsClient'

export const metadata = { title: 'Projects' }

export default async function ProjectsPage() {
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
      start_date, created_at, updated_at,
      clients(id, name, company_name),
      guardian_flags(status, severity),
      change_orders(id, status, title, total),
      sow_documents(id, status, version, sent_at, signed_at)
    `)
    .eq('workspace_id', session.workspaceId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })

  if (!canViewAll) {
    const { data: ids } = await (service as any)
      .from('project_members')
      .select('project_id')
      .eq('workspace_id', session.workspaceId)
      .eq('user_id', session.id)
    const projectIds = (ids || []).map((r: { project_id: string }) => r.project_id)
    if (projectIds.length > 0) {
      query = query.in('id', projectIds)
    } else {
      return <EmptyProjects canCreate={canCreate} />
    }
  }

  const { data: projects = [] } = await query

  return (
    <ProjectsClient
      projects={projects || []}
      canCreate={canCreate}
      canViewFinancials={hasPermission(session, 'VIEW_FINANCIALS')}
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
