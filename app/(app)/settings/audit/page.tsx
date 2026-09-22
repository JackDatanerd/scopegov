import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { fetchPaged } from '@/lib/utils/paginate'
import AuditLogClient from '@/components/settings/AuditLogClient'
import { getWorkspaceTimeZone } from '@/lib/utils/workspace-time'

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
  const [projects, members] = await Promise.all([
    fetchPaged<any>(
      (f, t) => (service as any)
        .from('projects')
        .select('id, name, deleted_at', { count: 'exact' })
        .eq('workspace_id', session.workspaceId)
        .order('name').order('id')
        .range(f, t),
      { maxRows: 5000 },
    ).then(r => r.rows).catch(err => { console.error('Audit page projects load failed:', err); return [] as any[] }),
    // FIX (re-audit, Reports & Audit section): this had no `.range()`/count
    // at all — the exact "PostgREST silently caps an unbounded read at its
    // Max Rows setting" bug the projects fetch right above (and this
    // section's own lib/utils/paginate.ts) exists specifically to prevent.
    // Everyone, not only active members, is kept forever for audit purposes
    // ("what did this person do before they left"), so a long-lived
    // workspace can realistically cross that cap over the years. It also had
    // no `.order()`, so which rows survived a truncation would have been
    // non-deterministic — could even have hidden a currently-active member
    // from the picker. Paged and ordered the same way as the projects fetch.
    fetchPaged<any>(
      (f, t) => (service as any)
        .from('workspace_members')
        .select('id, user_id, status, users!workspace_members_user_id_fkey(id, name, email)', { count: 'exact' })
        .eq('workspace_id', session.workspaceId)
        .order('created_at').order('id')
        .range(f, t),
      { maxRows: 5000 },
    ).then(r => r.rows).catch(err => { console.error('Audit page members load failed:', err); return [] as any[] }),
  ])

  const projectOptions = projects.map((p: any) => ({ id: p.id, name: p.name, deleted: !!p.deleted_at }))
  // FIX (re-audit, Reports & Audit section): `status` used to collapse to a
  // boolean (`active: m.status === 'active'`), so the client rendered every
  // non-active member as "(Former member)" — including someone who was just
  // invited (status 'invited') or whose invite link expired without them
  // ever joining (status 'expired'). Neither of those is a former member;
  // they never joined this workspace at all. Passing the real status lets
  // the client label each case correctly.
  const memberOptions = (members as any[])
    .filter((m: any) => m.users)
    .map((m: any) => ({ id: m.users.id, name: m.users.name || m.users.email, email: m.users.email, status: m.status as 'active' | 'invited' | 'expired' | 'deactivated' }))

  const timeZone = await getWorkspaceTimeZone(service, session.workspaceId)

  return <AuditLogClient projects={projectOptions} members={memberOptions} timeZone={timeZone} />
}
