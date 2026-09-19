import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { fetchPaged } from '@/lib/utils/paginate'
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
  // Deleted projects are included (labelled in the UI): "what happened on
  // that project" is a normal audit question and the project filter is now
  // backed by audit_log.project_id, which outlives the project row.
  // Paged so a workspace past PostgREST's max-rows cap still lists them all.
  const [projects, membersRes] = await Promise.all([
    fetchPaged<any>(
      (f, t) => (service as any)
        .from('projects')
        .select('id, name, deleted_at', { count: 'exact' })
        .eq('workspace_id', session.workspaceId)
        .order('name').order('id')
        .range(f, t),
      { maxRows: 5000 },
    ).then(r => r.rows).catch(err => { console.error('Audit page projects load failed:', err); return [] as any[] }),
    (service as any)
      .from('workspace_members')
      // Everyone, not only active members: "what did this person do before
      // they left" is precisely when a compliance-grade record matters.
      .select('user_id, status, users!workspace_members_user_id_fkey(id, name, email)')
      .eq('workspace_id', session.workspaceId),
  ])

  const projectOptions = projects.map((p: any) => ({ id: p.id, name: p.name, deleted: !!p.deleted_at }))
  const members = (membersRes.data || [])
    .filter((m: any) => m.users)
    .map((m: any) => ({ id: m.users.id, name: m.users.name || m.users.email, email: m.users.email, active: m.status === 'active' }))

  return <AuditLogClient projects={projectOptions} members={members} />
}
