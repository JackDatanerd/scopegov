'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import styles from '@/styles/admin.module.css'
import { fetchWithStepUp } from '@/lib/client/step-up'
import AdminHistory, { type HistoryRow } from '../../AdminHistory'

interface Detail {
  workspace: {
    id: string; name: string; agency_name: string; slug: string; plan_tier: string
    trial_ends_at: string | null; onboarding_completed_at: string | null
    first_sow_signed_at: string | null; created_at: string; deleted_at: string | null
    // suspended_by_admin (migration 091) distinguishes an admin suspension
    // from the workspace's own self-service delete — both share deleted_at.
    suspended_by_admin: boolean
    currency: string; timezone: string; industry: string
  }
  // null / undefined = that section's read failed (distinct from "empty" / "no billing row")
  members: Array<{
    id: string; status: string; created_at: string
    users: { email: string; name: string; deleted_at: string | null; suspended_by_admin: boolean } | null
    roles: { name: string } | null
  }> | null
  billing: {
    plan_interval: string | null; cancels_at_period_end: boolean; current_period_end: string | null
    payment_method_last4: string | null; payment_method_type: string | null; grace_period_started_at: string | null
    paystack_subscription_code: string | null; needs_paystack_cancel: boolean | null; cancelled_by_workspace_delete_at: string | null
  } | null | undefined
  recentActivity: Array<{ id: string; event_type: string; entity_type: string; entity_name: string | null; actor_name: string; created_at: string }> | null
  projectsByStatus: Record<string, number> | null
  history: HistoryRow[] | null
}

type Msg = { kind: 'ok' | 'warn' | 'error'; text: string }

const PLANS = ['trial', 'solo', 'starter', 'pro', 'agency']

export default function AdminWorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Msg | null>(null)
  // Kept as text so the field can be cleared and retyped (a numeric state snapped back to 1 on every empty edit).
  const [extendDays, setExtendDays] = useState('14')
  const [newPlan, setNewPlan] = useState('')
  // One field per action: a plan-change reason used to be sent as the suspension reason as well.
  const [planReason, setPlanReason] = useState('')
  const [suspendReason, setSuspendReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/workspaces/${id}`)
      const json = await res.json().catch(() => ({}))
      if (res.ok) { setData(json); setLoadError(null); setNotFound(false) }
      else if (res.status === 404) { setNotFound(true); setData(null) }
      else { setLoadError(res.status === 401 ? 'Your session expired — reload and sign in again.' : (json.error || `Request failed (${res.status}).`)) }
    } catch { setLoadError('Network error — could not reach the server.') }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function runAction(path: string, body?: Record<string, unknown>): Promise<boolean> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetchWithStepUp(`/api/admin/workspaces/${id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage({ kind: 'error', text: json.error || 'Something went wrong.' })
        // A conflict means the record moved under us — refresh so the buttons match reality.
        if (res.status === 409) await load()
        return false
      }
      const warnings: string[] = []
      if (json.paystackCancelOk === false) warnings.push('The Paystack subscription could NOT be cancelled — it is flagged and retried daily (see Billing → Paystack cancel pending).')
      if (json.paystackResumeOk === false) warnings.push('The Paystack subscription could NOT be re-enabled — resume it by hand (ops has been paged).')
      if (json.auditLogged === false) warnings.push('The action succeeded but could NOT be written to the admin audit log (ops has been paged).')
      let text = 'Done.'
      if (path === 'change-plan' && json.graceCleared) text = 'Done. The open payment-failure grace period was cleared.'
      setMessage(warnings.length ? { kind: 'warn', text: `Done, with problems: ${warnings.join(' ')}` } : { kind: 'ok', text })
      await load()
      return true
    } finally {
      setBusy(false)
    }
  }

  async function restore() {
    if (!data) return
    const { workspace } = data
    const label = workspace.agency_name || workspace.name
    if (!workspace.suspended_by_admin) {
      if (!confirm(`${label} was deleted by its owner, not suspended from this panel.\n\nRestoring reactivates its members and re-enables any subscription the deletion cancelled.\n\nRestore anyway?`)) return
      await runAction('restore', { confirmSelfDeleted: true })
    } else {
      await runAction('restore')
    }
  }

  if (loading && !data) return <div className={styles.empty}>Loading…</div>
  if (notFound) return <div className={styles.empty}>Workspace not found.</div>
  if (loadError && !data) {
    return (
      <div className={`${styles.notice} ${styles.noticeBad}`}>
        {loadError} <button className="btn btn-ghost btn-sm" onClick={() => load()}>Retry</button>
      </div>
    )
  }
  if (!data) return null

  const extendN = parseInt(extendDays, 10)
  const extendValid = Number.isInteger(extendN) && extendN >= 1 && extendN <= 365
  const suspended = !!data.workspace.deleted_at

  const { workspace, members, billing, recentActivity, projectsByStatus, history } = data

  return (
    <div>
      <div className={styles.header}>
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => router.push('/admin/workspaces')} style={{ marginBottom: 8 }}>&larr; Workspaces</button>
          <div className={styles.title}>{workspace.agency_name || workspace.name}</div>
          <div className={styles.subtitle}>{workspace.slug} · created {new Date(workspace.created_at).toLocaleDateString()}</div>
        </div>
        <div>
          {workspace.deleted_at
            ? <span className={`${styles.badge} ${styles.badgeRed}`}>{workspace.suspended_by_admin ? 'Suspended' : 'Deleted'}</span>
            : <span className={`${styles.badge} ${styles.badgeGreen}`}>Active</span>}
        </div>
      </div>

      {loadError && <div className={`${styles.notice} ${styles.noticeBad}`}>Could not refresh: {loadError}</div>}
      {message && (
        <div className={`${styles.notice} ${message.kind === 'error' ? styles.noticeBad : message.kind === 'warn' ? styles.noticeWarn : ''}`}>{message.text}</div>
      )}

      <div className={styles.grid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Plan</div>
          <div className={styles.statValue} style={{ fontSize: 18, textTransform: 'capitalize' }}>{workspace.plan_tier}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Trial ends</div>
          <div className={styles.statValue} style={{ fontSize: 15 }}>{workspace.trial_ends_at ? new Date(workspace.trial_ends_at).toLocaleDateString() : '—'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Onboarded</div>
          <div className={styles.statValue} style={{ fontSize: 15 }}>{workspace.onboarding_completed_at ? new Date(workspace.onboarding_completed_at).toLocaleDateString() : 'Not yet'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>First SOW signed</div>
          <div className={styles.statValue} style={{ fontSize: 15 }}>{workspace.first_sow_signed_at ? new Date(workspace.first_sow_signed_at).toLocaleDateString() : 'Never'}</div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Projects by status</div>
        {projectsByStatus == null ? (
          <div className={`${styles.notice} ${styles.noticeBad}`} style={{ margin: 12 }}>Could not load project counts — reload to retry.</div>
        ) : (
          <table className={styles.table}>
            <tbody>
              {Object.keys(projectsByStatus).length === 0
                ? <tr><td className={styles.empty} colSpan={2}>No projects yet.</td></tr>
                : Object.entries(projectsByStatus).map(([status, count]) => (
                  <tr key={status}><td>{status}</td><td className={styles.mono}>{count}</td></tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Members ({members == null ? '?' : members.length})</div>
        {members == null ? (
          <div className={`${styles.notice} ${styles.noticeBad}`} style={{ margin: 12 }}>Could not load members — reload to retry.</div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {members.map(m => (
                <tr key={m.id}>
                  <td>{m.users?.name || '—'}</td>
                  <td className={styles.mono}>{m.users?.email || '—'}</td>
                  <td>{m.roles?.name || '—'}</td>
                  <td>
                    {m.status}
                    {/* G4: a member whose ACCOUNT is suspended/deleted still shows as an "active" member of the workspace. */}
                    {m.users?.deleted_at && (
                      <span className={`${styles.badge} ${m.users.suspended_by_admin ? styles.badgeRed : styles.badgeGold}`} style={{ marginLeft: 6 }}>
                        {m.users.suspended_by_admin ? 'Account suspended' : 'Account deleted'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Billing</div>
        {billing === undefined ? (
          <div className={`${styles.notice} ${styles.noticeBad}`} style={{ margin: 12 }}>Could not load billing — reload to retry.</div>
        ) : (
          <dl className={styles.kv}>
            <dt>Payment method</dt>
            <dd>{billing?.payment_method_type ? `${billing.payment_method_type} •••• ${billing.payment_method_last4 || ''}` : 'None on file'}</dd>
            <dt>Billing interval</dt>
            <dd>{billing?.plan_interval || '—'}</dd>
            <dt>Paystack subscription</dt>
            <dd className={styles.mono}>{billing?.paystack_subscription_code || 'None'}</dd>
            <dt>Current period ends</dt>
            <dd>{billing?.current_period_end ? new Date(billing.current_period_end).toLocaleDateString() : '—'}</dd>
            <dt>Cancels at period end</dt>
            <dd>{billing?.cancels_at_period_end ? 'Yes' : 'No'}</dd>
            <dt>Grace period started</dt>
            <dd>{billing?.grace_period_started_at ? new Date(billing.grace_period_started_at).toLocaleDateString() : '—'}</dd>
            <dt>Paystack cancel pending</dt>
            <dd>{billing?.needs_paystack_cancel ? <span className={`${styles.badge} ${styles.badgeRed}`}>Yes — retried daily</span> : 'No'}</dd>
            {billing?.cancelled_by_workspace_delete_at && (<>
              <dt>Cancelled by suspension/delete</dt>
              <dd>{new Date(billing.cancelled_by_workspace_delete_at).toLocaleDateString()} (restore will re-enable it)</dd>
            </>)}
          </dl>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Recent activity</div>
        {recentActivity == null ? (
          <div className={`${styles.notice} ${styles.noticeBad}`} style={{ margin: 12 }}>Could not load recent activity — reload to retry.</div>
        ) : recentActivity.length === 0 ? (
          <div className={styles.empty}>No audit log entries yet.</div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>When</th><th>Event</th><th>Entity</th><th>Actor</th></tr></thead>
            <tbody>
              {recentActivity.map(a => (
                <tr key={a.id}>
                  <td className={styles.mono}>{new Date(a.created_at).toLocaleString()}</td>
                  <td>{a.event_type}</td>
                  <td>{a.entity_name || a.entity_type}</td>
                  <td>{a.actor_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Admin actions</div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ minWidth: 140 }}>Extend trial by</span>
            <input
              type="number" min={1} max={365} className={styles.input} style={{ minWidth: 80, width: 80 }}
              value={extendDays} onChange={e => setExtendDays(e.target.value)}
            />
            <span>days</span>
            <button
              className="btn btn-ghost btn-sm" disabled={busy || suspended || workspace.plan_tier !== 'trial' || !extendValid}
              onClick={() => runAction('extend-trial', { days: extendN })}
            >
              Extend
            </button>
            {workspace.plan_tier !== 'trial' && <span className={styles.muted}>Not on trial</span>}
            {workspace.plan_tier === 'trial' && !extendValid && <span className={styles.muted}>Enter 1–365</span>}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ minWidth: 140 }}>Change plan to</span>
            <select className={styles.select} value={newPlan} onChange={e => setNewPlan(e.target.value)}>
              <option value="">Select…</option>
              {PLANS.filter(p => p !== workspace.plan_tier).map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <input
              className={styles.input} placeholder="Reason (recorded in admin audit log)"
              value={planReason} onChange={e => setPlanReason(e.target.value)}
            />
            <button
              className="btn btn-ghost btn-sm" disabled={busy || suspended || !newPlan}
              onClick={() => runAction('change-plan', { plan: newPlan, reason: planReason }).then(ok => { if (ok) { setNewPlan(''); setPlanReason('') } })}
            >
              Change plan
            </button>
          </div>
          {suspended && <div className={styles.muted} style={{ fontSize: 11 }}>Restore the workspace before changing its plan or trial.</div>}
          <div className={`${styles.muted}`} style={{ fontSize: 11 }}>
            Changing plan here only updates ScopeGov&rsquo;s own entitlement — it does not touch Paystack. Reconcile any real subscription change there separately.
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {workspace.deleted_at ? (
              <>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={restore}>
                  Restore workspace
                </button>
                {!workspace.suspended_by_admin && <span className={styles.muted}>Deleted by its owner — restoring needs confirmation</span>}
              </>
            ) : (
              <>
                <input
                  className={styles.input} placeholder="Suspension reason (recorded in admin audit log)"
                  value={suspendReason} onChange={e => setSuspendReason(e.target.value)}
                />
                <button
                  className="btn btn-danger btn-sm" disabled={busy}
                  onClick={() => {
                    if (confirm(`Suspend ${workspace.agency_name || workspace.name}? Members will lose access immediately.`)) {
                      runAction('suspend', { reason: suspendReason }).then(ok => { if (ok) setSuspendReason('') })
                    }
                  }}
                >
                  Suspend workspace
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
