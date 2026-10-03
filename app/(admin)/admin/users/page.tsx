'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from '@/styles/admin.module.css'
import { useAdminList, useDebounced } from '@/lib/client/admin-list'

interface UserRow {
  id: string; email: string; name: string; is_platform_admin: boolean
  created_at: string; deleted_at: string | null; suspended_by_admin: boolean; erased: boolean
}

const PAGE_SIZE = 30

function statusBadge(u: UserRow) {
  if (!u.deleted_at) return <span className={`${styles.badge} ${styles.badgeGreen}`}>Active</span>
  // users.deleted_at is shared by admin suspensions, the person's own deletion, and erased accounts (Admin audit — G4).
  if (u.erased) return <span className={`${styles.badge} ${styles.badgeGray}`}>Erased</span>
  if (u.suspended_by_admin) return <span className={`${styles.badge} ${styles.badgeRed}`}>Suspended</span>
  return <span className={`${styles.badge} ${styles.badgeGold}`}>Deleted</span>
}

export default function AdminUsersPage() {
  const router = useRouter()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('active')
  const dq = useDebounced(q.trim())

  const params = new URLSearchParams({ page: String(page) })
  if (dq) params.set('q', dq)
  if (status) params.set('status', status)
  const { rows, total, loading, error, reload } = useAdminList<UserRow>(
    `/api/admin/users?${params}`, j => ({ rows: j.users || [], total: j.total ?? 0 }),
  )

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Users</div>
          <div className={styles.subtitle}>{error ? '—' : `${total} matching`}</div>
        </div>
      </div>

      <div className={styles.searchRow}>
        <input className={styles.input} placeholder="Search email or name…" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} />
        <select className={styles.select} value={status} onChange={e => { setStatus(e.target.value); setPage(1) }}>
          <option value="active">Active only</option>
          <option value="suspended">Suspended by an admin</option>
          <option value="deleted">Deleted by the user / erased</option>
          <option value="">All</option>
        </select>
      </div>

      {error && (
        <div className={`${styles.notice} ${styles.noticeBad}`}>
          {error} <button className="btn btn-ghost btn-sm" onClick={() => reload()}>Retry</button>
        </div>
      )}

      <div className={styles.card}>
        {loading && rows.length === 0 ? (
          <div className={styles.empty}>Loading…</div>
        ) : error ? null : rows.length === 0 ? (
          <div className={styles.empty}>No users match.</div>
        ) : (
          <table className={styles.table} style={loading ? { opacity: 0.6 } : undefined}>
            <thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map(u => (
                <tr key={u.id} className={styles.clickable} onClick={() => router.push(`/admin/users/${u.id}`)}>
                  <td>{u.name || '—'} {u.is_platform_admin && <span className={`${styles.badge} ${styles.badgeBlue}`} style={{ marginLeft: 6 }}>Admin</span>}</td>
                  <td className={styles.mono}>{u.email}</td>
                  <td className={styles.mono}>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td>{statusBadge(u)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className={styles.pager}>
          <button className="btn btn-ghost btn-sm" disabled={page <= 1 || loading} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn btn-ghost btn-sm" disabled={page >= totalPages || loading} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  )
}
