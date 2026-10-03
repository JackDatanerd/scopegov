'use client'

import styles from '@/styles/admin.module.css'
import { summarizeAdminMetadata } from '@/lib/admin/format'

export interface HistoryRow {
  id: string; admin_name: string; admin_email: string; event_type: string
  metadata: Record<string, unknown>; created_at: string
}

// G1: what has been done to THIS user / workspace from the panel, without paging the global audit log.
export default function AdminHistory({ rows }: { rows: HistoryRow[] | null | undefined }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Admin actions on this record</div>
      {rows == null ? (
        <div className={`${styles.notice} ${styles.noticeBad}`} style={{ margin: 12 }}>Could not load the admin action history — reload to retry.</div>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>No admin actions yet.</div>
      ) : (
        <table className={styles.table}>
          <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>
            {rows.map(r => {
              const summary = summarizeAdminMetadata(r.event_type, r.metadata)
              return (
                <tr key={r.id}>
                  <td className={styles.mono}>{new Date(r.created_at).toLocaleString()}</td>
                  <td>{r.admin_name}<div className={`${styles.mono} ${styles.muted}`}>{r.admin_email}</div></td>
                  <td className={styles.mono}>{r.event_type}</td>
                  <td>{summary || <span className={styles.muted}>—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
