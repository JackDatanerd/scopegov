'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import styles from '@/styles/admin.module.css'

interface WorkspaceRow {
  id: string
  name: string
  slug: string
  agency_name: string
  plan_tier: string
  trial_ends_at: string | null
  onboarding_completed_at: string | null
  created_at: string
  deleted_at: string | null
  // suspended_by_admin (migration 091) distinguishes an admin suspension
  // from the workspace's own self-service delete — both share deleted_at.
  suspended_by_admin: boolean
}

function planBadgeClass(plan: string): string {
  if (plan === 'agency' || plan === 'pro') return styles.badgeGreen
  if (plan === 'trial') return styles.badgeGold
  return styles.badgeBlue
}

export default function AdminWorkspacesPage() {
  const router = useRouter()
  const [rows, setRows] = useState<WorkspaceRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [plan, setPlan] = useState('')
  const [status, setStatus] = useState('active')
  const [loading, setLoading] = useState(true)
  const pageSize = 30

  const load = useCallback(async (opts?: { page?: number }) => {
    setLoading(true)
    const p = opts?.page ?? page
    const params = new URLSearchParams({ page: String(p) })
    if (q) params.set('q', q)
    if (plan) params.set('plan', plan)
    if (status) params.set('status', status)
    try {
      const res = await fetch(`/api/admin/workspaces?${params}`)
      const data = await res.json()
      if (res.ok) {
        setRows(data.workspaces)
        setTotal(data.total)
        setPage(p)
      }
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, plan, status])

  useEffect(() => { load({ page: 1 }) }, [q, plan, status]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Workspaces</div>
          <div className={styles.subtitle}>{total} matching</div>
        </div>
      </div>

      <div className={styles.searchRow}>
        <input
          className={styles.input}
          placeholder="Search name, slug, or agency…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <select className={styles.select} value={plan} onChange={e => setPlan(e.target.value)}>
          <option value="">All plans</option>
          <option value="trial">Trial</option>
          <option value="solo">Solo</option>
          <option value="starter">Starter</option>
          <option value="pro">Pro</option>
          <option value="agency">Agency</option>
        </select>
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
          <div className={styles.empty}>No workspaces match.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Plan</th>
                <th>Trial ends</th>
                <th>Onboarded</th>
                <th>Created</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(w => (
                <tr key={w.id} className={styles.clickable} onClick={() => router.push(`/admin/workspaces/${w.id}`)}>
                  <td>
                    <div>{w.agency_name || w.name}</div>
                    <div className={`${styles.mono} ${styles.muted}`}>{w.slug}</div>
                  </td>
                  <td><span className={`${styles.badge} ${planBadgeClass(w.plan_tier)}`}>{w.plan_tier}</span></td>
                  <td className={styles.mono}>{w.trial_ends_at ? new Date(w.trial_ends_at).toLocaleDateString() : '—'}</td>
                  <td>{w.onboarding_completed_at ? 'Yes' : <span className={styles.muted}>No</span>}</td>
                  <td className={styles.mono}>{new Date(w.created_at).toLocaleDateString()}</td>
                  <td>
                    {w.deleted_at
                      ? <span className={`${styles.badge} ${styles.badgeRed}`}>{w.suspended_by_admin ? 'Suspended' : 'Deleted'}</span>
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
