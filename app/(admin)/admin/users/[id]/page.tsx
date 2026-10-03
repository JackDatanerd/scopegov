'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import styles from '@/styles/admin.module.css'
import { fetchWithStepUp } from '@/lib/client/step-up'
import AdminHistory, { type HistoryRow } from '../../AdminHistory'

interface Detail {
  user: {
    id: string; email: string; name: string; is_platform_admin: boolean; created_at: string
    deleted_at: string | null; suspended_by_admin: boolean
  }
  // null = the read failed (distinct from "none" / "not enrolled" / "not banned")
  memberships: Array<{
    id: string; status: string; created_at: string
    workspaces: { id: string; name: string; agency_name: string; plan_tier: string; deleted_at: string | null } | null
    roles: { name: string } | null
  }> | null
  mfaEnrolled: boolean | null
  banned: boolean | null
  erased: boolean
  history: HistoryRow[] | null
}

type Msg = { kind: 'ok' | 'warn' | 'error'; text: string }

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Msg | null>(null)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/users/${id}`)
      const json = await res.json().catch(() => ({}))
      if (res.ok) { setData(json); setLoadError(null); setNotFound(false) }
      else if (res.status === 404) { setNotFound(true); setData(null) }
      else { setLoadError(res.status === 401 ? 'Your session expired — reload and sign in again.' : (json.error || `Request failed (${res.status}).`)) }
    } catch { setLoadError('Network error — could not reach the server.') }
    finally { setLoading(false) }
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
      if (!res.ok) { setMessage({ kind: 'error', text: json.error || 'Something went wrong.' }); return }
      const warnings: string[] = []
      if (json.sessionsRevoked === false) warnings.push('Existing sessions could not be signed out — use “Sign out of all sessions”.')
      if (json.emailSent === false) warnings.push('The user was NOT e-mailed about this change.')
      if (json.auditLogged === false) warnings.push('The action succeeded but could NOT be written to the admin audit log (ops has been paged).')
      setMessage(warnings.length ? { kind: 'warn', text: `Done, with problems: ${warnings.join(' ')}` } : { kind: 'ok', text: 'Done.' })
      await load()
    } finally { setBusy(false) }
  }

  async function restore() {
    if (!data) return
    const { user } = data
    if (!user.suspended_by_admin) {
      if (!confirm(`${user.email} was not suspended from this panel — they deleted the account themselves (or it was suspended before suspensions were tracked).\n\nRestoring brings back their login but NOT their workspace memberships.\n\nRestore anyway?`)) return
      await runAction('restore', { confirmSelfDeleted: true })
    } else {
      await runAction('restore')
    }
  }

  if (loading && !data) return <div className={styles.empty}>Loading…</div>
  if (notFound) return <div className={styles.empty}>User not found.</div>
  if (loadError && !data) {
    return (
      <div className={`${styles.notice} ${styles.noticeBad}`}>
        {loadError} <button className="btn btn-ghost btn-sm" onClick={() => load()}>Retry</button>
      </div>
    )
  }
  if (!data) return null

  const { user, memberships, mfaEnrolled, banned, erased, history } = data
  const statusBadge = !user.deleted_at
    ? <span className={`${styles.badge} ${styles.badgeGreen}`}>Active</span>
    : erased ? <span className={`${styles.badge} ${styles.badgeGray}`}>Erased</span>
    : user.suspended_by_admin ? <span className={`${styles.badge} ${styles.badgeRed}`}>Suspended</span>
    : <span className={`${styles.badge} ${styles.badgeGold}`}>Deleted by user</span>

  return (
    <div>
      <div className={styles.header}>
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => router.push('/admin/users')} style={{ marginBottom: 8 }}>&larr; Users</button>
          <div className={styles.title}>{user.name || user.email}</div>
          <div className={styles.subtitle}>{user.email} · joined {new Date(user.created_at).toLocaleDateString()}</div>
        </div>
        <div>{statusBadge}</div>
      </div>

      {loadError && <div className={`${styles.notice} ${styles.noticeBad}`}>Could not refresh: {loadError}</div>}
      {message && (
        <div className={`${styles.notice} ${message.kind === 'error' ? styles.noticeBad : message.kind === 'warn' ? styles.noticeWarn : ''}`}>{message.text}</div>
      )}

      <div className={styles.grid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Two-factor auth</div>
          <div className={styles.statValue} style={{ fontSize: 16 }}>{mfaEnrolled == null ? 'Unknown' : mfaEnrolled ? 'Enrolled' : 'Not enrolled'}</div>
          {mfaEnrolled == null && <div className={styles.statHint}>could not read factors</div>}
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Auth status</div>
          <div className={styles.statValue} style={{ fontSize: 16 }}>{banned == null ? 'Unknown' : banned ? 'Banned' : 'Normal'}</div>
          {banned == null && <div className={styles.statHint}>could not read the auth record</div>}
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Workspaces</div>
          <div className={styles.statValue} style={{ fontSize: 16 }}>{memberships == null ? '?' : memberships.length}</div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Workspace memberships</div>
        {memberships == null ? (
          <div className={`${styles.notice} ${styles.noticeBad}`} style={{ margin: 12 }}>Could not load memberships — reload to retry.</div>
        ) : memberships.length === 0 ? (
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
                  <td>{m.workspaces?.agency_name || m.workspaces?.name || <span className={styles.muted}>Deleted workspace</span>}
                    {m.workspaces?.deleted_at && <span className={`${styles.badge} ${styles.badgeRed}`} style={{ marginLeft: 6 }}>Suspended/deleted</span>}</td>
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
            {/* Disabled only when we KNOW there is no factor — an unreadable factor list must not block the reset. */}
            <button className="btn btn-ghost btn-sm" disabled={busy || mfaEnrolled === false} onClick={() => runAction('reset-mfa')}>
              Reset two-factor auth
            </button>
            {mfaEnrolled === false && <span className={styles.muted}>No factor enrolled</span>}
            {mfaEnrolled == null && <span className={styles.muted}>Factors could not be read — the reset will check again</span>}
          </div>
          <div>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction('revoke-sessions')}>
              Sign out of all sessions
            </button>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {user.deleted_at ? (
              erased ? (
                <span className={styles.muted}>This account was permanently erased and cannot be restored.</span>
              ) : (
                <>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={restore}>Restore account</button>
                  {!user.suspended_by_admin && <span className={styles.muted}>Deleted by the user — restoring needs confirmation</span>}
                </>
              )
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

      <AdminHistory rows={history} />
    </div>
  )
}
