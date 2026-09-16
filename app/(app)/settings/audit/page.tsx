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
          {/* FIX (re-audit, Reports & Audit section): this said "(Owner
              only)" but roles here are fully custom per-workspace
              (roles.permissions jsonb, no fixed role table) — VIEW_AUDIT_LOG
              can be granted to any role, independently of VIEW_FINANCIALS or
              anything else. The old copy implied a narrower, fixed
              permission model than this app actually has. */}
          <p style={{ fontSize: 13, color: 'var(--text-2)' }}>Audit log access requires the VIEW_AUDIT_LOG permission.</p>
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
      // FIX (re-audit, Reports & Audit section): this used to filter to
      // .eq('status', 'active') only. The backend (audit-export's actorId
      // param) has always accepted any actor, active or not — this was the
      // only thing stopping someone from filtering the audit log by a
      // departed member, which is precisely when "what did this person do
      // before they left" tends to matter for a compliance-grade record.
      // Fetch everyone and let the client label inactive ones.
      .select('user_id, status, users!workspace_members_user_id_fkey(id, name, email)')
      .eq('workspace_id', session.workspaceId),
  ])

  const projects = (projectsRes.data || []).map((p: any) => ({ id: p.id, name: p.name }))
  const members = (membersRes.data || [])
    .filter((m: any) => m.users)
    .map((m: any) => ({ id: m.users.id, name: m.users.name || m.users.email, email: m.users.email, active: m.status === 'active' }))

  return <AuditLogClient projects={projects} members={members} />
}
