'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from '@/styles/admin.module.css'
import { useAdminList, useDebounced } from '@/lib/client/admin-list'

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
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [plan, setPlan] = useState('')
  const [status, setStatus] = useState('active')
  const dq = useDebounced(q.trim())
  const pageSize = 30

  const params = new URLSearchParams({ page: String(page) })
  if (dq) params.set('q', dq)
  if (plan) params.set('plan', plan)
  if (status) params.set('status', status)
  // Debounced + sequenced + error-aware (Admin audit — B5): see lib/client/admin-list.ts.
  const { rows, total, loading, error, reload } = useAdminList<WorkspaceRow>(
    `/api/admin/workspaces?${params}`, j => ({ rows: j.workspaces || [], total: j.total ?? 0 }),
  )

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Workspaces</div>
          <div className={styles.subtitle}>{error ? '—' : `${total} matching`}</div>
        </div>
      </div>

      <div className={styles.searchRow}>
        <input
          className={styles.input}
          placeholder="Search name, slug, or agency…"
          value={q}
          onChange={e => { setQ(e.target.value); setPage(1) }}
        />
        <select className={styles.select} value={plan} onChange={e => { setPlan(e.target.value); setPage(1) }}>
          <option value="">All plans</option>
          <option value="trial">Trial</option>
          <option value="solo">Solo</option>
          <option value="starter">Starter</option>
          <option value="pro">Pro</option>
          <option value="agency">Agency</option>
        </select>
        <select className={styles.select} value={status} onChange={e => { setStatus(e.target.value); setPage(1) }}>
          <option value="active">Active only</option>
          <option value="suspended">Suspended by an admin</option>
          <option value="deleted">Deleted by the owner</option>
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
          <div className={styles.empty}>No workspaces match.</div>
        ) : (
          <table className={styles.table} style={loading ? { opacity: 0.6 } : undefined}>
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
          <button className="btn btn-ghost btn-sm" disabled={page <= 1 || loading} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn btn-ghost btn-sm" disabled={page >= totalPages || loading} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  )
}
