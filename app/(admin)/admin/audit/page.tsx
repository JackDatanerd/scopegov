import { createServiceClient } from '@/lib/supabase/server'
import styles from '@/styles/admin.module.css'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export default async function AdminAuditLogPage({ searchParams }: { searchParams: { page?: string } }) {
  const service = createServiceClient() as any
  const page = Math.max(1, parseInt(searchParams?.page || '1', 10) || 1)
  const from = (page - 1) * PAGE_SIZE
  const to = from + PAGE_SIZE - 1

  const { data: rows, count } = await service
    .from('platform_admin_audit_log')
    .select('id, admin_name, admin_email, event_type, target_type, target_label, target_id, metadata, ip_address, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to)

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE))

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Admin audit log</div>
          <div className={styles.subtitle}>Every action taken from this panel — separate from each workspace&rsquo;s own activity feed</div>
        </div>
      </div>

      <div className={styles.card}>
        {(rows || []).length === 0 ? (
          <div className={styles.empty}>No admin actions recorded yet.</div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>IP</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className={styles.mono}>{new Date(r.created_at).toLocaleString()}</td>
                  <td>{r.admin_name}<div className={`${styles.mono} ${styles.muted}`}>{r.admin_email}</div></td>
                  <td className={styles.mono}>{r.event_type}</td>
                  <td>
                    <span className={`${styles.badge} ${styles.badgeGray}`}>{r.target_type}</span>{' '}
                    {r.target_label || <span className={styles.muted}>—</span>}
                  </td>
                  <td className={styles.mono}>{r.ip_address || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className={styles.pager}>
          <a className="btn btn-ghost btn-sm" aria-disabled={page <= 1} href={`/admin/audit?page=${Math.max(1, page - 1)}`}>Previous</a>
          <span>Page {page} of {totalPages}</span>
          <a className="btn btn-ghost btn-sm" aria-disabled={page >= totalPages} href={`/admin/audit?page=${Math.min(totalPages, page + 1)}`}>Next</a>
        </div>
      </div>
    </div>
  )
}
