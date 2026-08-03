import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AuditLogClient from '@/components/settings/AuditLogClient'

export const metadata = { title: 'Audit Log' }

export default async function AuditLogPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  if (!hasPermission(session, 'VIEW_AUDIT_LOG')) {
    return (
      <div className="page">
        <h1 className="page-title">Audit Log</h1>
        <div className="surface surface-p" style={{ textAlign: 'center', padding: 48 }}>
          <i className="ti ti-lock" style={{ fontSize: 28, color: 'var(--text-4)', display: 'block', marginBottom: 12 }} />
          <p style={{ fontSize: 13, color: 'var(--text-2)' }}>Audit log access requires the VIEW_AUDIT_LOG permission (Owner only).</p>
        </div>
      </div>
    )
  }

  const service = createServiceClient()
  const [projectsRes, membersRes] = await Promise.all([
    (service as any)
      .from('projects')
      .select('id, name')
      .eq('workspace_id', session.workspaceId)
      .is('deleted_at', null)
      .order('name'),
    (service as any)
      .from('workspace_members')
      .select('user_id, users!workspace_members_user_id_fkey(id, name, email)')
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'active'),
  ])

  const projects = (projectsRes.data || []).map((p: any) => ({ id: p.id, name: p.name }))
  const members = (membersRes.data || [])
    .filter((m: any) => m.users)
    .map((m: any) => ({ id: m.users.id, name: m.users.name || m.users.email, email: m.users.email }))

  return <AuditLogClient projects={projects} members={members} />
}
