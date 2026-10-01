'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import styles from '@/styles/admin.module.css'
import { fetchWithStepUp } from '@/lib/client/step-up'

interface Detail {
  user: { id: string; email: string; name: string; is_platform_admin: boolean; created_at: string; deleted_at: string | null }
  memberships: Array<{
    id: string; status: string; created_at: string
    workspaces: { id: string; name: string; agency_name: string; plan_tier: string; deleted_at: string | null } | null
    roles: { name: string } | null
  }>
  mfaEnrolled: boolean
  banned: boolean
}

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch(`/api/admin/users/${id}`)
    if (res.ok) setData(await res.json())
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function runAction(path: string, body?: Record<string, unknown>) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetchWithStepUp(`/api/admin/users/${id}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      })
      const json = await res.json().catch(() => ({}))
      setMessage(res.ok ? 'Done.' : (json.error || 'Something went wrong.'))
      if (res.ok) await load()
    } finally { setBusy(false) }
  }

  if (loading) return <div className={styles.empty}>Loading…</div>
  if (!data) return <div className={styles.empty}>User not found.</div>

  const { user, memberships, mfaEnrolled, banned } = data

  return (
    <div>
      <div className={styles.header}>
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => router.push('/admin/users')} style={{ marginBottom: 8 }}>&larr; Users</button>
          <div className={styles.title}>{user.name || user.email}</div>
          <div className={styles.subtitle}>{user.email} · joined {new Date(user.created_at).toLocaleDateString()}</div>
        </div>
        <div>
          {user.deleted_at
            ? <span className={`${styles.badge} ${styles.badgeRed}`}>Suspended</span>
            : <span className={`${styles.badge} ${styles.badgeGreen}`}>Active</span>}
        </div>
      </div>

      {message && <div className={styles.card} style={{ padding: 12, fontSize: 12.5 }}>{message}</div>}

      <div className={styles.grid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Two-factor auth</div>
          <div className={styles.statValue} style={{ fontSize: 16 }}>{mfaEnrolled ? 'Enrolled' : 'Not enrolled'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Auth status</div>
          <div className={styles.statValue} style={{ fontSize: 16 }}>{banned ? 'Banned' : 'Normal'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Workspaces</div>
          <div className={styles.statValue} style={{ fontSize: 16 }}>{memberships.length}</div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Workspace memberships</div>
        {memberships.length === 0 ? (
          <div className={styles.empty}>No workspace memberships.</div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>Workspace</th><th>Role</th><th>Member status</th><th>Plan</th></tr></thead>
            <tbody>
              {memberships.map(m => (
                <tr
                  key={m.id}
                  className={m.workspaces ? styles.clickable : ''}
                  onClick={() => m.workspaces && router.push(`/admin/workspaces/${m.workspaces.id}`)}
                >
                  <td>{m.workspaces?.agency_name || m.workspaces?.name || <span className={styles.muted}>Deleted workspace</span>}</td>
                  <td>{m.roles?.name || '—'}</td>
                  <td>{m.status}</td>
                  <td style={{ textTransform: 'capitalize' }}>{m.workspaces?.plan_tier || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Admin actions</div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-ghost btn-sm" disabled={busy || !mfaEnrolled} onClick={() => runAction('reset-mfa')}>
              Reset two-factor auth
            </button>
            {!mfaEnrolled && <span className={styles.muted}>No factor enrolled</span>}
          </div>
          <div>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction('revoke-sessions')}>
              Sign out of all sessions
            </button>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {user.deleted_at ? (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction('restore')}>
                Restore account
              </button>
            ) : user.is_platform_admin ? (
              <span className={styles.muted}>Platform admins can&rsquo;t be suspended from here.</span>
            ) : (
              <>
                <input
                  className={styles.input} placeholder="Reason (recorded in admin audit log)"
                  value={reason} onChange={e => setReason(e.target.value)}
                />
                <button
                  className="btn btn-danger btn-sm" disabled={busy}
                  onClick={() => {
                    if (confirm(`Suspend ${user.email}? They will be signed out and unable to sign in.`)) {
                      runAction('suspend', { reason })
                    }
                  }}
                >
                  Suspend account
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
