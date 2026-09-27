'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import styles from '@/styles/admin.module.css'

interface Detail {
  workspace: {
    id: string; name: string; agency_name: string; slug: string; plan_tier: string
    trial_ends_at: string | null; onboarding_completed_at: string | null
    first_sow_signed_at: string | null; created_at: string; deleted_at: string | null
    currency: string; timezone: string; industry: string
  }
  members: Array<{ id: string; status: string; created_at: string; users: { email: string; name: string } | null; roles: { name: string } | null }>
  billing: { plan_tier?: string; cancels_at_period_end: boolean; current_period_end: string | null; payment_method_last4: string | null; payment_method_type: string | null; grace_period_started_at: string | null } | null
  recentActivity: Array<{ id: string; event_type: string; entity_type: string; entity_name: string | null; actor_name: string; created_at: string }>
  projectsByStatus: Record<string, number>
}

const PLANS = ['trial', 'solo', 'starter', 'pro', 'agency']

export default function AdminWorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [extendDays, setExtendDays] = useState(14)
  const [newPlan, setNewPlan] = useState('')
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch(`/api/admin/workspaces/${id}`)
    if (res.ok) setData(await res.json())
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function runAction(path: string, body?: Record<string, unknown>) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/workspaces/${id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage(json.error || 'Something went wrong.')
      } else {
        setMessage('Done.')
        await load()
      }
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className={styles.empty}>Loading…</div>
  if (!data) return <div className={styles.empty}>Workspace not found.</div>

  const { workspace, members, billing, recentActivity, projectsByStatus } = data

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
            ? <span className={`${styles.badge} ${styles.badgeRed}`}>Suspended</span>
            : <span className={`${styles.badge} ${styles.badgeGreen}`}>Active</span>}
        </div>
      </div>

      {message && <div className={styles.card} style={{ padding: 12, fontSize: 12.5 }}>{message}</div>}

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
        <table className={styles.table}>
          <tbody>
            {Object.keys(projectsByStatus).length === 0
              ? <tr><td className={styles.empty} colSpan={2}>No projects yet.</td></tr>
              : Object.entries(projectsByStatus).map(([status, count]) => (
                <tr key={status}><td>{status}</td><td className={styles.mono}>{count}</td></tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Members ({members.length})</div>
        <table className={styles.table}>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id}>
                <td>{m.users?.name || '—'}</td>
                <td className={styles.mono}>{m.users?.email || '—'}</td>
                <td>{m.roles?.name || '—'}</td>
                <td>{m.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Billing</div>
        <dl className={styles.kv}>
          <dt>Payment method</dt>
          <dd>{billing?.payment_method_type ? `${billing.payment_method_type} •••• ${billing.payment_method_last4 || ''}` : 'None on file'}</dd>
          <dt>Current period ends</dt>
          <dd>{billing?.current_period_end ? new Date(billing.current_period_end).toLocaleDateString() : '—'}</dd>
          <dt>Cancels at period end</dt>
          <dd>{billing?.cancels_at_period_end ? 'Yes' : 'No'}</dd>
          <dt>Grace period started</dt>
          <dd>{billing?.grace_period_started_at ? new Date(billing.grace_period_started_at).toLocaleDateString() : '—'}</dd>
        </dl>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>Recent activity</div>
        {recentActivity.length === 0 ? (
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
              value={extendDays} onChange={e => setExtendDays(parseInt(e.target.value, 10) || 1)}
            />
            <span>days</span>
            <button
              className="btn btn-ghost btn-sm" disabled={busy || workspace.plan_tier !== 'trial'}
              onClick={() => runAction('extend-trial', { days: extendDays })}
            >
              Extend
            </button>
            {workspace.plan_tier !== 'trial' && <span className={styles.muted}>Not on trial</span>}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ minWidth: 140 }}>Change plan to</span>
            <select className={styles.select} value={newPlan} onChange={e => setNewPlan(e.target.value)}>
              <option value="">Select…</option>
              {PLANS.filter(p => p !== workspace.plan_tier).map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <input
              className={styles.input} placeholder="Reason (recorded in admin audit log)"
              value={reason} onChange={e => setReason(e.target.value)}
            />
            <button
              className="btn btn-ghost btn-sm" disabled={busy || !newPlan}
              onClick={() => runAction('change-plan', { plan: newPlan, reason })}
            >
              Change plan
            </button>
          </div>
          <div className={`${styles.muted}`} style={{ fontSize: 11 }}>
            Changing plan here only updates ScopeGov&rsquo;s own entitlement — it does not touch Paystack. Reconcile any real subscription change there separately.
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
            {workspace.deleted_at ? (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction('restore')}>
                Restore workspace
              </button>
            ) : (
              <button
                className="btn btn-danger btn-sm" disabled={busy}
                onClick={() => {
                  if (confirm(`Suspend ${workspace.agency_name || workspace.name}? Members will lose access immediately.`)) {
                    runAction('suspend', { reason })
                  }
                }}
              >
                Suspend workspace
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
