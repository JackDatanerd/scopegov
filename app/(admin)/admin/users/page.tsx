'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import styles from '@/styles/admin.module.css'

interface UserRow {
  id: string; email: string; name: string; is_platform_admin: boolean
  created_at: string; deleted_at: string | null
}

export default function AdminUsersPage() {
  const router = useRouter()
  const [rows, setRows] = useState<UserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('active')
  const [loading, setLoading] = useState(true)
  const pageSize = 30

  const load = useCallback(async (opts?: { page?: number }) => {
    setLoading(true)
    const p = opts?.page ?? page
    const params = new URLSearchParams({ page: String(p) })
    if (q) params.set('q', q)
    if (status) params.set('status', status)
    try {
      const res = await fetch(`/api/admin/users?${params}`)
      const data = await res.json()
      if (res.ok) { setRows(data.users); setTotal(data.total); setPage(p) }
    } finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status])

  useEffect(() => { load({ page: 1 }) }, [q, status]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Users</div>
          <div className={styles.subtitle}>{total} matching</div>
        </div>
      </div>

      <div className={styles.searchRow}>
        <input className={styles.input} placeholder="Search email or name…" value={q} onChange={e => setQ(e.target.value)} />
        <select className={styles.select} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="active">Active only</option>
          <option value="deleted">Suspended/deleted only</option>
          <option value="">All</option>
        </select>
      </div>

      <div className={styles.card}>
        {loading ? (
          <div className={styles.empty}>Loading…</div>
        ) : rows.length === 0 ? (
          <div className={styles.empty}>No users match.</div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map(u => (
                <tr key={u.id} className={styles.clickable} onClick={() => router.push(`/admin/users/${u.id}`)}>
                  <td>{u.name || '—'} {u.is_platform_admin && <span className={`${styles.badge} ${styles.badgeBlue}`} style={{ marginLeft: 6 }}>Admin</span>}</td>
                  <td className={styles.mono}>{u.email}</td>
                  <td className={styles.mono}>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td>
                    {u.deleted_at
                      ? <span className={`${styles.badge} ${styles.badgeRed}`}>Suspended</span>
                      : <span className={`${styles.badge} ${styles.badgeGreen}`}>Active</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className={styles.pager}>
          <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => load({ page: page - 1 })}>Previous</button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => load({ page: page + 1 })}>Next</button>
        </div>
      </div>
    </div>
  )
}
