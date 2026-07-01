import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { formatRelative } from '@/lib/utils/format'

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
  const { data: entries = [] } = await (service as any)
    .from('audit_log')
    .select('id, event_type, entity_type, entity_name, actor_name, actor_email, created_at, metadata, ip_address')
    .eq('workspace_id', session.workspaceId)
    .order('created_at', { ascending: false })
    .limit(200)

  function eventColour(type: string) {
    if (type.includes('signed') || type.includes('accepted') || type.includes('completed') || type.includes('joined')) return 'var(--green)'
    if (type.includes('declined') || type.includes('failed') || type.includes('stalled') || type.includes('deleted')) return 'var(--red)'
    if (type.includes('flag') || type.includes('guardian') || type.includes('escalated')) return 'var(--amber)'
    if (type.includes('billing') || type.includes('plan')) return 'var(--blue)'
    return 'var(--text-3)'
  }

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">Audit log</h1>
          <p className="page-sub">{(entries || []).length} events · immutable record</p>
        </div>
      </div>

      <div className="surface" style={{ overflow: 'hidden' }}>
        <table className="gov-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Event</th>
              <th>Actor</th>
              <th>Entity</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {(entries || []).map((e: any) => (
              <tr key={e.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: eventColour(e.event_type), flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 12, fontFamily: 'IBM Plex Mono, monospace', color: 'var(--text-2)' }}>{e.event_type}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{e.entity_type}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div style={{ fontSize: 13 }}>{e.actor_name || 'System'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{e.actor_email}</div>
                </td>
                <td style={{ fontSize: 13, color: 'var(--text-2)' }}>
                  {e.entity_name || '—'}
                  {e.ip_address && (
                    <div style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'IBM Plex Mono, monospace' }}>{e.ip_address}</div>
                  )}
                </td>
                <td style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                  {formatRelative(e.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!(entries || []).length && (
          <div className="empty-state" style={{ padding: '40px 0' }}>
            <i className="ti ti-clock empty-state-icon" />
            <p className="empty-state-title">No audit events yet</p>
          </div>
        )}
      </div>
    </div>
  )
}
