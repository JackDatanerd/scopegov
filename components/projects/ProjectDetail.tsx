// components/projects/ProjectDetail.tsx
// C14: TeamTab "Add member" button wired — loads available members,
//      shows modal, posts to /api/projects/[id]/members

'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { SessionUser } from '@/lib/supabase/types'
import BillingTab from '@/components/invoices/BillingTab'
import FlagCollaboration from './FlagCollaboration'
import ProjectDiscussion from './ProjectDiscussion'
import {
  formatCurrency, formatDate, formatRelative,
  projectStatusLabel, sowStatusLabel, coStatusLabel, flagStatusLabel,
  PROJECT_TYPE_ICONS,
} from '@/lib/utils/format'

const TABS = [
  { key: 'overview',   label: 'Overview',      icon: 'ti-layout-dashboard' },
  { key: 'sow',        label: 'SOW',           icon: 'ti-file-description' },
  { key: 'guardian',   label: 'Guardian',      icon: 'ti-shield-bolt' },
  { key: 'co',         label: 'Change Orders', icon: 'ti-git-merge' },
  { key: 'billing',    label: 'Billing',       icon: 'ti-receipt' },
  { key: 'discussion', label: 'Discussion',    icon: 'ti-messages' },
  { key: 'activity',   label: 'Activity',      icon: 'ti-clock' },
  { key: 'team',       label: 'Team',          icon: 'ti-users' },
]

function projectPill(status: string): string {
  const m: Record<string, string> = {
    'Active': 'green', 'Awaiting Signature': 'amber', 'Changes Requested': 'amber',
    'Stalled': 'red', 'Complete': 'slate', 'Draft': 'slate', 'Intake': 'blue', 'Archived': 'slate',
  }
  return m[status] || 'slate'
}
function sowPill(status: string): string {
  const m: Record<string, string> = {
    draft: 'slate', awaiting_signature: 'amber', signed: 'green',
    declined: 'red', changes_requested: 'amber', withdrawn: 'slate', expired: 'red',
  }
  return m[status] || 'slate'
}
function coPill(status: string): string {
  const m: Record<string, string> = {
    draft: 'slate', awaiting_response: 'amber', accepted: 'green',
    declined: 'red', countered: 'purple', closed: 'slate', stalled: 'red',
    withdrawn: 'slate', exception_granted: 'blue',
    // FIX (doc-completeness audit, migration 014)
    awaiting_countersignature: 'amber',
  }
  return m[status] || 'slate'
}
function flagPill(status: string): string {
  // FIX (re-audit, Guardian ghost-feature finding): borderline_review had no
  // entry, so any flag in that status rendered with the flat default
  // ('slate') pill — no visual distinction from an already-closed flag.
  const m: Record<string, string> = { open: 'red', borderline_review: 'amber', resolved: 'green', closed: 'slate', converted_to_co: 'blue' }
  return m[status] || 'slate'
}

interface Permissions {
  editSow: boolean; sendSow: boolean; createCo: boolean; sendCo: boolean
  approveFlags: boolean; grantExceptions: boolean; markComplete: boolean
  markDeliverable: boolean; markMilestone: boolean; submitGuardian: boolean
  viewGuardianHistory: boolean; assignTeam: boolean; viewFinancials: boolean
  deleteProject: boolean; sendInvoices: boolean; moderateMessages: boolean
}

interface Props {
  project: any
  milestones: any[]
  amendments: any[]
  team: any[]
  activity: any[]
  invoices: any[]
  reconciliation: any[]
  defaultPaymentInstructions?: string
  effectiveContractValue: number
  initialTab: string
  isNewProject: boolean
  session: SessionUser
  permissions: Permissions
  // Phase 3 — Approval Chains: keyed by "sow:<id>" / "co:<id>", present
  // only for documents currently held on a pending approval chain.
  pendingApprovals?: Record<string, { id: string; current_step: number; total_steps: number }>
}

export default function ProjectDetail({
  project, milestones, amendments, team, activity, invoices, reconciliation,
  effectiveContractValue, initialTab, permissions, pendingApprovals = {}, session,
  defaultPaymentInstructions = '',
}: Props) {
  const router = useRouter()
  const [tab,        setTab]        = useState(initialTab)
  const [completing, setCompleting] = useState(false)
  const [archiving,  setArchiving]  = useState(false)
  const [error,      setError]      = useState('')
  const [unreadMessages, setUnreadMessages] = useState(0)

  useEffect(() => {
    fetch(`/api/projects/${project.id}/messages/unread-count`)
      .then(res => res.json())
      .then(json => setUnreadMessages(json.count || 0))
      .catch(() => {})
  }, [project.id])

  const currency      = project.currency || 'USD'
  const isActive      = ['Active', 'Stalled'].includes(project.status)
  const guardianActive = project.status === 'Active'
  const [deleting,   setDeleting]   = useState(false)

  // FIX: DELETE_PROJECTS was fully built and enforced server-side (only
  // Draft/Intake, never if a signed SOW exists — archive instead) but had
  // no UI anywhere to trigger it. Mirror the same constraint client-side
  // so the button only appears when the action would actually succeed.
  const canDelete = permissions.deleteProject && ['Draft', 'Intake'].includes(project.status)
    && !(project.sow_documents || []).some((s: any) => s.status === 'signed')

  async function handleDelete() {
    if (!confirm(`Delete "${project.name}"? This can't be undone.`)) return
    setDeleting(true); setError('')
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      router.push('/projects')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete project')
      setDeleting(false)
    }
  }

  const recoveredAmt  = amendments.reduce((s: number, a: any) => s + (a.financial_impact || 0), 0)
  // FIX (doc-completeness audit, migration 014)
  const openCos       = (project.change_orders || []).filter((co: any) => ['awaiting_response','countered','awaiting_countersignature'].includes(co.status))
  const atRiskAmt     = openCos.reduce((s: number, co: any) => s + (co.total || 0), 0)
  const baseValue     = project.contract_value || 0
  // FIX (re-audit, Guardian ghost-feature finding): this badge only ever
  // counted status === 'open', so a borderline_review flag — which needs a
  // human to confirm or dismiss it just as much as an open flag needs
  // resolving — raised zero visual signal anywhere in the product.
  const openFlagCount = (project.guardian_flags || []).filter(
    (f: any) => f.status === 'open' || f.status === 'borderline_review'
  ).length

  async function handleMarkComplete() {
    const blockingCos = (project.change_orders || []).filter((co: any) =>
      ['awaiting_response','countered','stalled','awaiting_countersignature'].includes(co.status)
    )
    if (blockingCos.length > 0) {
      setError(`${blockingCos.length} change order${blockingCos.length !== 1 ? 's' : ''} must be resolved before marking complete.`)
      return
    }
    setCompleting(true); setError('')
    try {
      const res = await fetch(`/api/projects/${project.id}/complete`, { method: 'POST' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setCompleting(false) }
  }

  async function handleArchive() {
    if (!confirm(`Archive "${project.name}"? It'll be hidden from active project views but stays fully accessible from a direct link.`)) return
    setArchiving(true); setError('')
    try {
      const res = await fetch(`/api/projects/${project.id}/archive`, { method: 'POST' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setArchiving(false) }
  }

  // FIX (deep audit, section 7): Archived was a one-way door — no UI or
  // API path back to Complete. Mirrors handleArchive's shape.
  const [unarchiving, setUnarchiving] = useState(false)
  async function handleUnarchive() {
    setUnarchiving(true); setError('')
    try {
      const res = await fetch(`/api/projects/${project.id}/unarchive`, { method: 'POST' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setUnarchiving(false) }
  }

  return (
    <div>
      {/* Header */}
      <div style={{ padding: '24px 40px 0', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <Link href="/projects" style={{ fontSize: 12, color: 'var(--text-3)' }}>Projects</Link>
          <i className="ti ti-chevron-right" style={{ fontSize: 10, color: 'var(--text-4)' }} />
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{project.clients?.name}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              <i className={`ti ${PROJECT_TYPE_ICONS[project.type] || 'ti-folder'}`} style={{ fontSize: 16, color: 'var(--text-3)' }} />
              <h1 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 26, fontWeight: 400, margin: 0, letterSpacing: '-0.01em' }}>
                {project.name}
              </h1>
              {project.disc && <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{project.disc}</span>}
              <span className={`pill pill-${projectPill(project.status)}`}>{projectStatusLabel(project.status)}</span>
              {guardianActive && (
                <span className="pill pill-green"><i className="ti ti-shield-bolt" style={{ fontSize: 10 }} /> Guardian active</span>
              )}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
              <Link href={`/clients/${project.client_id}`} style={{ color: 'var(--green)' }}>{project.clients?.name}</Link>
              {project.start_date && <> · Started {formatDate(project.start_date)}</>}
              {project.internal_ref && <> · {project.internal_ref}</>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {permissions.createCo && isActive && (
              <Link href={`/projects/${project.id}/co/new`}>
                <button className="btn btn-ghost btn-sm"><i className="ti ti-plus" style={{ fontSize: 12 }} /> New CO</button>
              </Link>
            )}
            {permissions.markComplete && project.status === 'Active' && (
              <button className="btn btn-ghost btn-sm" onClick={handleMarkComplete} disabled={completing}>
                {completing ? <span className="spin spin-dark" /> : <><i className="ti ti-check" style={{ fontSize: 12 }} /> Mark complete</>}
              </button>
            )}
            {permissions.markComplete && project.status === 'Complete' && (
              <button className="btn btn-ghost btn-sm" onClick={handleArchive} disabled={archiving}>
                {archiving ? <span className="spin spin-dark" /> : <><i className="ti ti-archive" style={{ fontSize: 12 }} /> Archive</>}
              </button>
            )}
            {permissions.markComplete && project.status === 'Archived' && (
              <button className="btn btn-ghost btn-sm" onClick={handleUnarchive} disabled={unarchiving}>
                {unarchiving ? <span className="spin spin-dark" /> : <><i className="ti ti-archive-off" style={{ fontSize: 12 }} /> Unarchive</>}
              </button>
            )}
            {canDelete && (
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={handleDelete} disabled={deleting}>
                {deleting ? <span className="spin spin-dark" /> : <><i className="ti ti-trash" style={{ fontSize: 12 }} /> Delete</>}
              </button>
            )}
          </div>
        </div>

        {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

        {permissions.viewFinancials && (
          <div style={{ display: 'flex', gap: 28, marginBottom: 16, flexWrap: 'wrap' }}>
            <MetricBlock label="Original value" value={formatCurrency(baseValue, currency)} />
            {recoveredAmt > 0 && <MetricBlock label="Recovered" value={`+${formatCurrency(recoveredAmt, currency)}`} color="var(--green)" />}
            {atRiskAmt > 0 && <MetricBlock label="At risk (pending COs)" value={formatCurrency(atRiskAmt, currency)} color="var(--gold)" />}
            <MetricBlock label="Effective total" value={formatCurrency(effectiveContractValue, currency)} bold />
          </div>
        )}

        {permissions.viewFinancials && effectiveContractValue > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div className="lb-track">
              <div style={{ flex: baseValue / effectiveContractValue, background: 'var(--blue)', height: 4 }} />
              {recoveredAmt > 0 && <div style={{ flex: recoveredAmt / effectiveContractValue, background: 'var(--green)', height: 4 }} />}
              {atRiskAmt > 0 && <div style={{ flex: atRiskAmt / effectiveContractValue, background: 'var(--gold)', height: 4 }} />}
            </div>
            <div className="lb-cap">
              <span className="lb-cap-item"><span className="lb-dot" style={{ background: 'var(--blue)' }} />Base</span>
              {recoveredAmt > 0 && <span className="lb-cap-item"><span className="lb-dot" style={{ background: 'var(--green)' }} />Recovered</span>}
              {atRiskAmt > 0 && <span className="lb-cap-item"><span className="lb-dot" style={{ background: 'var(--gold)' }} />Pending</span>}
            </div>
          </div>
        )}

        <div className="tabbar">
          {TABS.map(t => (
            <button key={t.key} className={`tabi${tab === t.key ? ' act' : ''}`} onClick={() => setTab(t.key)}>
              <i className={`ti ${t.icon}`} style={{ fontSize: 12, marginRight: 5 }} />
              {t.label}
              {t.key === 'guardian' && openFlagCount > 0 && <span className="tabi-badge">{openFlagCount}</span>}
              {t.key === 'discussion' && unreadMessages > 0 && <span className="tabi-badge">{unreadMessages}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ padding: '24px 40px', maxWidth: 1080 }}>
        {tab === 'overview' && <OverviewTab project={project} milestones={milestones} amendments={amendments} permissions={permissions} currency={currency} router={router} />}
        {tab === 'sow'      && <SowTab project={project} sows={project.sow_documents || []} amendments={amendments} permissions={permissions} router={router} pendingApprovals={pendingApprovals} />}
        {tab === 'guardian' && <GuardianTab project={project} flags={project.guardian_flags || []} permissions={permissions} router={router} />}
        {tab === 'co'       && <CoTab project={project} cos={project.change_orders || []} permissions={permissions} currency={currency} pendingApprovals={pendingApprovals} team={team} />}
        {tab === 'billing'  && <BillingTab project={project} milestones={milestones} invoices={invoices} reconciliation={reconciliation} permissions={permissions} currency={currency} router={router} defaultPaymentInstructions={defaultPaymentInstructions} />}
        {tab === 'discussion' && (
          <ProjectDiscussion
            projectId={project.id}
            currentUserId={session.id}
            canModerate={permissions.moderateMessages}
            onRead={() => setUnreadMessages(0)}
            team={team
              .map((t: any) => t.workspace_members?.users)
              .filter((u: any): u is { id: string; name: string; email: string; avatar_url: string | null } => !!u)
              .map((u: any) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatar_url }))}
          />
        )}
        {tab === 'activity' && <ActivityTab activity={activity} />}
        {tab === 'team'     && <TeamTab project={project} team={team} permissions={permissions} />}
      </div>
    </div>
  )
}

function MetricBlock({ label, value, color, bold }: { label: string; value: string; color?: string; bold?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 19, color: color || 'var(--text)', fontWeight: bold ? 500 : 400 }}>{value}</div>
    </div>
  )
}

function ScopeAdjustModal({ projectId, deliverable, onClose, onDone }: any) {
  const [newValue, setNewValue] = useState(deliverable)
  const [reason, setReason]     = useState('')
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')

  async function submit() {
    if (!newValue.trim() || !reason.trim()) { setError('Both fields are required.'); return }
    setBusy(true); setError('')
    try {
      const res  = await fetch('/api/guardian/scope-adjustment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, deliverable, oldValue: deliverable, newValue: newValue.trim(), reason: reason.trim() }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok) onDone()
      else setError(json.error || 'Could not save that adjustment.')
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Adjust deliverable</h2>
        <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
          Corrects the scope snapshot directly — for fixing a typo or wording issue, not for adding/removing scope. Real scope changes still go through a change order.
        </p>
        <label className="form-label">Deliverable</label>
        <input className="form-input" value={newValue} onChange={(e) => setNewValue(e.target.value)} style={{ marginBottom: 12 }} />
        <label className="form-label">Reason for adjustment</label>
        <textarea className="form-input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Fixing a typo from the original SOW draft" />
        {error && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
            {busy ? <span className="spin" /> : 'Save adjustment'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── OVERVIEW TAB ──────────────────────────────────────────────
function OverviewTab({ project, milestones, amendments, permissions, currency, router }: any) {
  // FIX: one-to-one relation (see /api/guardian/check for details) — no [0]
  const snapshot     = project.project_scope_snapshot
  const deliverables = snapshot?.deliverables || []
  const outOfScope   = snapshot?.out_of_scope || []
  const sowDocs      = project.sow_documents || []
  const [adjustingDeliverable, setAdjustingDeliverable] = useState<string | null>(null)
  const hasSigned    = sowDocs.some((s: any) => s.status === 'signed')
  const latestSow    = sowDocs.length ? [...sowDocs].sort((a: any, b: any) => (b.version ?? 0) - (a.version ?? 0))[0] : null
  const paidAmount   = milestones.filter((m: any) => m.status === 'paid').reduce((s: number, m: any) => s + (m.amount || 0), 0)
  const overdueAmount= milestones.filter((m: any) => m.status === 'overdue').reduce((s: number, m: any) => s + (m.amount || 0), 0)

  const SOW_STATUS_LABEL: Record<string, string> = {
    draft: 'Draft — not yet sent', sent: 'Sent to client', awaiting_signature: 'Awaiting signature',
    signed: 'Signed', changes_requested: 'Client requested changes', declined: 'Declined by client', withdrawn: 'Withdrawn',
    // FIX (section-9 audit, 9-G3): 'expired' is a real status now that
    // cron/sow-expiry actually writes it; this map had no entry, so the
    // Overview tab fell through to printing the raw value.
    expired: 'Signing link expired',
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 20, alignItems: 'start' }}>
      <div>
        {/* Always-available project info — previously this tab showed almost
            nothing until a SOW was signed, leaving it near-blank for every
            project in Draft/Intake/awaiting-signature. */}
        <div className="surface surface-p" style={{ marginBottom: 16 }}>
          <div className="sec-title" style={{ marginBottom: 12 }}>Project details</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px', fontSize: 13 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>Client</div>
              <div>{project.clients?.name || project.clients?.company_name || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>Type</div>
              <div>{project.type || '—'}</div>
            </div>
            {permissions.viewFinancials && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>Contract value</div>
                <div style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrency(project.contract_value || 0, currency)}</div>
              </div>
            )}
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>Start date</div>
              <div>{project.start_date ? formatDate(project.start_date) : '—'}</div>
            </div>
            {project.type === 'retainer' && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>Retainer duration</div>
                <div>
                  {project.retainer_duration_months
                    ? `${project.retainer_duration_months} month${project.retainer_duration_months !== 1 ? 's' : ''}`
                    : 'Not set — monthly billing won\u2019t auto-generate'}
                </div>
              </div>
            )}
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>SOW status</div>
              <div>{latestSow ? (SOW_STATUS_LABEL[latestSow.status] || latestSow.status) : 'No SOW created yet'}{latestSow ? ` · v${latestSow.version}` : ''}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>Guardian</div>
              <div>{project.status === 'Active' ? (project.guardian_email || 'Active') : 'Not yet active'}</div>
            </div>
          </div>
          {project.disc && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--surface-2)', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>
              {project.disc}
            </div>
          )}
        </div>
        {hasSigned && (deliverables.length > 0 || outOfScope.length > 0) && (
          <div className="surface surface-p" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div className="sec-title">Scope snapshot</div>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {snapshot?.last_updated_by === 'amendment' ? 'Updated by amendment' :
                 snapshot?.last_updated_by === 'scope_adjustment' ? 'Manually adjusted' : 'From signed SOW'}
              </span>
            </div>
            {deliverables.length > 0 && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>In scope</div>
                {deliverables.map((d: any, i: number) => (
                  <div key={i} className="scope-entry" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="scope-glyph in"><i className="ti ti-check" style={{ fontSize: 9 }} /></div>
                      <span>{d.title || d}</span>
                    </div>
                    {permissions.editSow && (
                      <button className="btn-icon" title="Adjust wording" onClick={() => setAdjustingDeliverable(d.title || d)}>
                        <i className="ti ti-pencil" style={{ fontSize: 11 }} />
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}
            {outOfScope.length > 0 && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '14px 0 6px' }}>Excluded</div>
                {outOfScope.map((d: any, i: number) => (
                  <div key={i} className="scope-entry">
                    <div className="scope-glyph out"><i className="ti ti-x" style={{ fontSize: 9 }} /></div>
                    <span style={{ color: 'var(--text-2)' }}>{d.title || d}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        {!hasSigned && (
          <div className="surface">
            <div className="empty-state" style={{ padding: '36px 24px' }}>
              <i className="ti ti-file-description empty-state-icon" />
              <p className="empty-state-title">No signed SOW</p>
              <p className="empty-state-sub">Guardian activates when your client signs. Create and send the SOW to get started.</p>
            </div>
          </div>
        )}
        {amendments.length > 0 && (
          <div className="surface surface-p" style={{ marginTop: 16 }}>
            <div className="sec-title" style={{ marginBottom: 12 }}>Amendments ({amendments.length})</div>
            {amendments.map((a: any) => (
              <div key={a.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--surface-2)', fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 500 }}>{a.title}</span>
                  {permissions.viewFinancials && (
                    <span style={{ color: 'var(--green)', fontFamily: 'IBM Plex Mono, monospace' }}>+{formatCurrency(a.financial_impact, currency)}</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                  {formatDate(a.effective_at)}
                  {a.added_deliverables?.length > 0 && ` · ${a.added_deliverables.length} deliverable${a.added_deliverables.length !== 1 ? 's' : ''} added`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="surface surface-p">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <div className="sec-title">Payment milestones</div>
            {overdueAmount > 0 && <span className="pill pill-red pill-sm">{formatCurrency(overdueAmount, currency)} overdue</span>}
          </div>
          {milestones.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-3)' }}>No milestones yet</p>
          ) : (
            milestones.map((m: any) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--surface-2)', fontSize: 13 }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 12 }}>{m.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{m.trigger}{m.due_date ? ` · ${formatDate(m.due_date)}` : ''}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {permissions.viewFinancials && (
                    <div style={{ fontSize: 12, fontFamily: 'IBM Plex Mono, monospace', marginBottom: 3 }}>{formatCurrency(m.amount, currency)}</div>
                  )}
                  <MilestonePill status={m.status} />
                </div>
              </div>
            ))
          )}
          {permissions.viewFinancials && milestones.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--text-3)' }}>Paid</span>
              <span style={{ color: 'var(--green)', fontWeight: 500, fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrency(paidAmount, currency)}</span>
            </div>
          )}
        </div>
      </div>
      {adjustingDeliverable !== null && (
        <ScopeAdjustModal projectId={project.id} deliverable={adjustingDeliverable}
          onClose={() => setAdjustingDeliverable(null)}
          onDone={() => { setAdjustingDeliverable(null); router.refresh() }} />
      )}
    </div>
  )
}

function MilestonePill({ status }: { status: string }) {
  const map:   Record<string, string> = { pending: 'slate', invoiced: 'blue', paid: 'green', overdue: 'red' }
  const label: Record<string, string> = { pending: 'Pending', invoiced: 'Invoiced', paid: 'Paid', overdue: 'Overdue' }
  return <span className={`pill pill-${map[status] || 'slate'} pill-sm`}>{label[status] || status}</span>
}

// ── SOW TAB ───────────────────────────────────────────────────
function SowTab({ project, sows, amendments, permissions, router, pendingApprovals }: any) {
  const [sending, setSending] = useState(false)
  const [error,   setError]   = useState('')
  const [sentForApproval, setSentForApproval] = useState(false)
  // FIX (re-audit, "current SOW" finding): defense-in-depth on top of the
  // server-side .order() fix in app/(app)/projects/[id]/page.tsx — sort
  // here too so this never silently picks a stale version if `sows` ever
  // arrives unsorted from some other caller.
  const sortedSows = [...(sows || [])].sort((a: any, b: any) => b.version - a.version)
  const currentSow = sortedSows[0]
  const pendingApproval = currentSow ? pendingApprovals?.[`sow:${currentSow.id}`] : null

  // FIX: previously this tab's empty state just described what to do
  // ("Generate a Statement of Work from your project brief") with no way
  // to actually do it — any project where the creation wizard was closed
  // before generating a SOW was a permanent dead end. This rebuilds that
  // step as a standalone modal for an already-existing project.
  const [briefOpen, setBriefOpen] = useState(false)

  async function handleSendSow() {
    setSending(true); setError(''); setSentForApproval(false)
    try {
      const res  = await fetch(`/api/sow/${currentSow.id}/send`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to send')
      if (json.pendingApproval) setSentForApproval(true)
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send SOW')
    } finally { setSending(false) }
  }

  // FIX (SOW-lifecycle fix round): this was the one action on this tab
  // with no res.ok check — handleSendSow and handleRemind right below it
  // both surface a failure, but this called router.refresh() unconditionally
  // regardless of outcome, exactly the bug already described and fixed for
  // the standalone SOW editor page's own withdraw handler (see
  // app/(app)/projects/[id]/sow/[sowId]/page.tsx). A failed withdraw here —
  // permission lapsed, already signed, network error — looked identical to
  // a successful one, with no error shown and the client possibly still
  // holding a live signing link.
  async function handleWithdraw() {
    if (!confirm('Withdraw this SOW? The client link will be deactivated.')) return
    setError('')
    try {
      const res  = await fetch(`/api/sow/${currentSow.id}/withdraw`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setError(json.error || 'Failed to withdraw'); return }
      router.refresh()
    } catch {
      setError('Failed to withdraw')
    }
  }

  // FIX (re-audit): this had zero feedback — no loading state, no error
  // handling, no refresh — unlike its siblings handleSendSow/handleWithdraw
  // right above it. A failed reminder (e.g. cooldown, or the SOW no longer
  // being awaiting_signature) gave the user no signal either way.
  // FIX (section-9 audit, 9-G1): a withdrawn, declined or expired SOW
  // used to render with ZERO actions — Edit/Send gate on 'draft',
  // Remind/Withdraw on 'awaiting_signature', and the "Generate SOW"
  // button only shows when the project has no SOWs at all. A client
  // declining a SOW simply halted the product. /api/sow/[id]/reopen
  // clones it forward into a fresh editable draft.
  const [reopening, setReopening] = useState(false)
  async function handleReopen() {
    setReopening(true); setError('')
    try {
      const res  = await fetch(`/api/sow/${currentSow.id}/reopen`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not start a new version')
      router.push(`/projects/${project.id}/sow/${json.sowId}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start a new version')
      setReopening(false)
    }
  }

  const [reminding, setReminding] = useState(false)
  async function handleRemind() {
    setReminding(true); setError('')
    try {
      const res  = await fetch(`/api/sow/${currentSow.id}/remind`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to send reminder')
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send reminder')
    } finally { setReminding(false) }
  }

  return (
    <div>
      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}
      {sentForApproval && (
        <div className="surface surface-p" style={{ marginBottom: 14, borderLeft: '3px solid var(--amber)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <i className="ti ti-shield-check" style={{ fontSize: 16, color: 'var(--amber)' }} />
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
            Sent for approval — this SOW will go to the client automatically once it&rsquo;s signed off.{' '}
            <Link href="/approvals" style={{ color: 'var(--gold)', fontWeight: 500 }}>View in queue →</Link>
          </div>
        </div>
      )}
      {sortedSows.length === 0 ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-file-description empty-state-icon" />
            <p className="empty-state-title">No SOW yet</p>
            <p className="empty-state-sub">Generate a Statement of Work from your project brief.</p>
            {permissions.editSow && (
              <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} onClick={() => setBriefOpen(true)}>
                <i className="ti ti-sparkles" style={{ fontSize: 12 }} /> Generate SOW
              </button>
            )}
          </div>
        </div>
      ) : (
        <div>
          {currentSow && (
            <div className="surface surface-p" style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>SOW v{currentSow.version}</span>
                    <span className={`pill pill-${sowPill(currentSow.status)}`}>{sowStatusLabel(currentSow.status)}</span>
                    {pendingApproval && (
                      <span className="pill pill-amber">
                        <i className="ti ti-shield-check" style={{ fontSize: 10 }} /> Awaiting approval ({pendingApproval.current_step}/{pendingApproval.total_steps})
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {currentSow.sent_at && <>Sent {formatDate(currentSow.sent_at)} · </>}
                    {currentSow.signed_at && <>Signed {formatDate(currentSow.signed_at)}</>}
                    {!currentSow.sent_at && 'Not yet sent'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {currentSow.status === 'draft' && permissions.editSow && (
                    <Link href={`/projects/${project.id}/sow/${currentSow.id}`}>
                      <button className="btn btn-ghost btn-sm"><i className="ti ti-pencil" style={{ fontSize: 12 }} /> Edit</button>
                    </Link>
                  )}
                  {currentSow.status === 'draft' && permissions.sendSow && !pendingApproval && (
                    <button className="btn btn-primary btn-sm" onClick={handleSendSow} disabled={sending}>
                      {sending ? <span className="spin" /> : <><i className="ti ti-send" style={{ fontSize: 12 }} /> Send to client</>}
                    </button>
                  )}
                  {currentSow.status === 'draft' && pendingApproval && (
                    <Link href="/approvals">
                      <button className="btn btn-ghost btn-sm"><i className="ti ti-shield-check" style={{ fontSize: 12 }} /> Awaiting approval</button>
                    </Link>
                  )}
                  {currentSow.status === 'awaiting_signature' && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={handleRemind} disabled={reminding}>
                        {reminding ? <span className="spin" /> : <><i className="ti ti-refresh" style={{ fontSize: 12 }} /> Remind</>}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={handleWithdraw}><i className="ti ti-x" style={{ fontSize: 12 }} /> Withdraw</button>
                    </>
                  )}
                  {['withdrawn', 'declined', 'expired'].includes(currentSow.status) && permissions.editSow && (
                    <button className="btn btn-primary btn-sm" onClick={handleReopen} disabled={reopening}>
                      {reopening
                        ? <span className="spin" />
                        : <><i className="ti ti-refresh" style={{ fontSize: 12 }} /> Start new version</>}
                    </button>
                  )}
                  {currentSow.signed_at && (
                    <a href={`/api/pdf/sow/${currentSow.id}`} target="_blank" className="btn btn-ghost btn-sm">
                      <i className="ti ti-download" style={{ fontSize: 12 }} /> Download PDF
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
          {sortedSows.length > 1 && (
            <div>
              <div className="sec-title" style={{ marginBottom: 10 }}>Version history</div>
              {sortedSows.map((s: any) => (
                <div key={s.id} className="surface surface-p" style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>v{s.version}</span>
                    <span className={`pill pill-${sowPill(s.status)} pill-sm`} style={{ marginLeft: 8 }}>{sowStatusLabel(s.status)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{formatDate(s.created_at)}</span>
                    {s.signed_at && (
                      <a href={`/api/pdf/sow/${s.id}`} target="_blank" className="btn btn-ghost btn-xs"><i className="ti ti-download" style={{ fontSize: 11 }} /> PDF</a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {amendments.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="sec-title" style={{ marginBottom: 10 }}>Amendments ({amendments.length})</div>
              {amendments.map((a: any) => (
                <div key={a.id} className="surface surface-p" style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Effective {formatDate(a.effective_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {briefOpen && (
        <GenerateSowModal project={project} onClose={() => setBriefOpen(false)}
          onDone={() => { setBriefOpen(false); router.refresh() }} />
      )}
    </div>
  )
}

function GenerateSowModal({ project, onClose, onDone }: any) {
  const [briefText,        setBriefText]        = useState('')
  const [parsing,          setParsing]           = useState(false)
  const [reviewing,        setReviewing]         = useState(false)
  const [objective,        setObjective]         = useState('')
  const [deliverables,     setDeliverables]      = useState('')
  const [outOfScope,       setOutOfScope]        = useState('')
  const [timeline,         setTimeline]          = useState('')
  const [paymentStructure, setPaymentStructure]  = useState('50_50')
  const [revisionRounds,   setRevisionRounds]    = useState('2')
  const [generating,       setGenerating]        = useState(false)
  const [error,            setError]             = useState('')

  async function extractFromBrief() {
    if (!briefText.trim()) { setReviewing(true); return }
    setParsing(true); setError('')
    try {
      const res  = await fetch('/api/sow/parse-brief', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ briefText, projectType: project.type }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      // FIX (section-9 audit, 9-B1): /api/sow/parse-brief returns
      // `{ brief: {...} }` — this read the fields off the top level, so
      // every one of them was undefined. The AI call ran, the rate-limit
      // budget was spent, and the user got a blank review form with no
      // error to explain it. app/(app)/projects/new/page.tsx has always
      // read `json.brief` correctly; this copy of the same flow never did,
      // so brief extraction was dead for every SOW generated from an
      // existing project.
      const brief = json.brief || {}
      setObjective(brief.objective || '')
      setDeliverables(brief.deliverables || '')
      setOutOfScope(brief.outOfScope || '')
      setTimeline(brief.timeline || '')
      if (brief.paymentStructure) setPaymentStructure(brief.paymentStructure)
      if (brief.revisionRounds)   setRevisionRounds(String(brief.revisionRounds))
      setReviewing(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not read that brief — you can still fill the fields in manually below.')
      setReviewing(true)
    } finally { setParsing(false) }
  }

  async function generate() {
    if (!objective.trim() || !deliverables.trim()) {
      setError('Objective and deliverables are required.')
      return
    }
    setGenerating(true); setError('')
    try {
      const res  = await fetch('/api/sow/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id, projectType: project.type,
          objective, deliverables, outOfScope, timeline,
          paymentStructure, revisionRounds: parseInt(revisionRounds) || 2,
          contractValue: project.contract_value || 0, currency: project.currency || 'USD',
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'SOW generation failed — please try again.')
      onDone()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'SOW generation failed — please try again.')
    } finally { setGenerating(false) }
  }

  return (
    <>
      <div className="modal-bg" onClick={onClose} />
      <div className="modal" style={{ maxWidth: 560 }}>
        <h2 className="modal-title">Generate SOW</h2>
        {!reviewing ? (
          <>
            <p className="modal-sub">Paste your project brief and we&apos;ll extract the key fields — or skip straight to filling them in yourself.</p>
            {error && <p className="ferr">{error}</p>}
            <textarea className="finp" style={{ minHeight: 140, resize: 'vertical' }} autoFocus
              placeholder="Paste the client's brief, scope notes, or project description here…"
              value={briefText} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setBriefText(e.target.value)} />
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setReviewing(true)}>Fill in manually</button>
              <button className="btn btn-primary" onClick={extractFromBrief} disabled={parsing}>
                {parsing ? <span className="spin" /> : 'Extract with AI'}
              </button>
            </div>
          </>
        ) : (
          <>
            {error && <p className="ferr">{error}</p>}
            <div className="fgrp">
              <label className="flbl">Objective</label>
              <textarea className="finp" style={{ minHeight: 50 }} value={objective}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setObjective(e.target.value)} />
            </div>
            <div className="fgrp">
              <label className="flbl">Deliverables <span className="fhint">(one per line)</span></label>
              <textarea className="finp" style={{ minHeight: 80 }} value={deliverables}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDeliverables(e.target.value)} />
            </div>
            <div className="fgrp">
              <label className="flbl">Out of scope <span className="fhint">(one per line, optional)</span></label>
              <textarea className="finp" style={{ minHeight: 50 }} value={outOfScope}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setOutOfScope(e.target.value)} />
            </div>
            <div className="f2">
              <div className="fgrp">
                <label className="flbl">Timeline <span className="fhint">(optional)</span></label>
                <input className="finp" value={timeline} placeholder="e.g. 6 weeks"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTimeline(e.target.value)} />
              </div>
              <div className="fgrp">
                <label className="flbl">Revision rounds</label>
                <input type="number" className="finp" min={1} max={5} value={revisionRounds}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRevisionRounds(e.target.value)} />
              </div>
            </div>
            <div className="fgrp">
              <label className="flbl">Payment structure</label>
              <select className="finp" value={paymentStructure} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPaymentStructure(e.target.value)}>
                <option value="50_50">50% upfront, 50% on delivery</option>
                <option value="100_upfront">100% upfront</option>
                <option value="milestones">Milestones</option>
                <option value="monthly">Monthly</option>
                <option value="on_delivery">100% on delivery</option>
              </select>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={generate} disabled={generating}>
                {generating ? <span className="spin" /> : 'Generate SOW'}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

// ── GUARDIAN TAB ──────────────────────────────────────────────
function GuardianTab({ project, flags, permissions, router }: any) {
  const [pasteMode,    setPasteMode]    = useState(false)
  const [pasteText,    setPasteText]    = useState('')
  const [submitting,   setSubmitting]   = useState(false)
  const [submitError,  setSubmitError]  = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  // BUG: the check's actual verdict (in_scope / out_of_scope / duplicate /
  // pending / classification_failed) was fetched from the API and then
  // discarded — the UI just closed the paste box and silently refreshed,
  // so an in_scope/borderline result (no flag created) gave the user zero
  // feedback that anything happened at all.
  const [lastResult,   setLastResult]   = useState<any>(null)

  const isActive   = project.status === 'Active'
  const openFlags  = flags.filter((f: any) => f.status === 'open')
  // FIX (re-audit, Guardian ghost-feature finding): borderline_review flags
  // (added in a prior fix round) were entirely invisible in this UI — no
  // filter chip, no action buttons, and excluded from every "needs
  // attention" count. Treating them alongside 'open' here is the minimum
  // needed for anyone to even notice they exist.
  const needsReviewFlags = flags.filter((f: any) => f.status === 'open' || f.status === 'borderline_review')
  const filteredFlags = filterStatus === 'all' ? flags : flags.filter((f: any) => f.status === filterStatus)

  async function handlePasteSubmit() {
    if (!pasteText.trim()) return
    setSubmitting(true); setSubmitError(''); setLastResult(null)
    try {
      const res  = await fetch('/api/guardian/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, content: pasteText, source: 'paste' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setPasteText(''); setPasteMode(false)
      setLastResult(json)
      // Only worth a refresh if a flag was actually created — otherwise
      // there's nothing new to pull from the server.
      if (json.flagId) setTimeout(() => router.refresh(), 1500)
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed')
    } finally { setSubmitting(false) }
  }

  const VERDICT_COPY: Record<string, { icon: string; color: string; bg: string; title: string }> = {
    in_scope:              { icon: 'ti-shield-check', color: 'var(--green)', bg: 'var(--green-lt)', title: 'In scope — no action needed' },
    covered_by_co:         { icon: 'ti-shield-check', color: 'var(--green)', bg: 'var(--green-lt)', title: 'Covered by an accepted change order' },
    // FIX (re-audit, Guardian ghost-feature finding): this copy predates
    // borderline items actually raising a flag — it was still telling the
    // user "no flag raised" even after a borderline_review flag had just
    // been created below.
    borderline:            { icon: 'ti-shield-half-filled', color: 'var(--amber)', bg: '#FFF7ED', title: 'Borderline — flagged for human review' },
    out_of_scope:          { icon: 'ti-shield-x', color: 'var(--red)', bg: 'var(--red-lt)', title: 'Out of scope — flag created below' },
    duplicate:             { icon: 'ti-copy', color: 'var(--text-3)', bg: 'var(--surface-2)', title: 'Duplicate of a recent check — skipped' },
    pending:               { icon: 'ti-clock', color: 'var(--text-3)', bg: 'var(--surface-2)', title: 'No signed SOW yet — nothing to check against' },
    classification_failed: { icon: 'ti-alert-triangle', color: 'var(--red)', bg: 'var(--red-lt)', title: 'Classification failed — try again in a moment' },
  }

  return (
    <div>
      <div className="surface surface-p" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 9, height: 9, borderRadius: '50%', background: isActive ? 'var(--green)' : 'var(--text-4)', boxShadow: isActive ? '0 0 0 3px rgba(26,92,58,.15)' : 'none' }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {isActive ? 'Guardian active' : ['Complete','Archived'].includes(project.status) ? 'Guardian inactive' : 'Guardian not yet active'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {isActive ? `Monitoring via ${project.guardian_email || 'forwarding email'}` : 'Activates when client signs the SOW'}
            </div>
          </div>
        </div>
        {isActive && project.guardian_email && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 3 }}>Forward client emails to</div>
            <code style={{ fontSize: 12, background: 'var(--surface-2)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border)' }}>
              {project.guardian_email}
            </code>
          </div>
        )}
      </div>

      {isActive && permissions.submitGuardian && (
        <div style={{ marginBottom: 16 }}>
          {!pasteMode ? (
            <button className="btn btn-ghost btn-sm" onClick={() => { setPasteMode(true); setLastResult(null) }}>
              <i className="ti ti-clipboard" style={{ fontSize: 12 }} /> Paste email or message
            </button>
          ) : (
            <div className="surface surface-p">
              <label className="flbl">Paste client message to check against scope</label>
              <textarea className="finp" style={{ minHeight: 100, resize: 'vertical', marginTop: 6 }}
                value={pasteText} autoFocus placeholder="Paste the client's email or message here…"
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPasteText(e.target.value)} />
              {submitError && <p className="ferr">{submitError}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-primary btn-sm" onClick={handlePasteSubmit} disabled={submitting || !pasteText.trim()}>
                  {submitting ? <span className="spin" /> : 'Check scope'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setPasteMode(false); setPasteText('') }}>Cancel</button>
              </div>
            </div>
          )}
          {lastResult && !pasteMode && (() => {
            const v = VERDICT_COPY[lastResult.outcome] || VERDICT_COPY.pending
            return (
              <div className="surface surface-p" style={{ marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 10, background: v.bg, border: `1px solid ${v.color}40` }}>
                <i className={`ti ${v.icon}`} style={{ fontSize: 16, color: v.color, marginTop: 1 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: v.color }}>{v.title}</div>
                  {lastResult.matchedReference && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>Matched against: {lastResult.matchedReference}</div>
                  )}
                  {typeof lastResult.creepConfidence === 'number' && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>Creep confidence: {Math.round(lastResult.creepConfidence * 100)}%</div>
                  )}
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => setLastResult(null)} aria-label="Dismiss">
                  <i className="ti ti-x" style={{ fontSize: 12 }} />
                </button>
              </div>
            )
          })()}
        </div>
      )}

      {flags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {/* FIX (re-audit, Guardian ghost-feature finding): added the
              borderline_review chip — it had no filter at all, so even
              "All" scrolling past it gave no way to isolate just the
              items waiting on a human's confirm/dismiss call. */}
          {['all','open','borderline_review','converted_to_co','resolved','closed'].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              style={{
                padding: '4px 11px', borderRadius: 99, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${filterStatus === s ? 'var(--green)' : 'var(--border)'}`,
                background: filterStatus === s ? 'var(--green-lt)' : 'var(--surface)',
                color: filterStatus === s ? 'var(--green)' : 'var(--text-2)',
              }}>
              {s === 'all' ? `All (${flags.length})` :
               s === 'open' ? `Open (${openFlags.length})` :
               s === 'borderline_review' ? `Needs review (${needsReviewFlags.length - openFlags.length})` :
               s === 'converted_to_co' ? 'CO Created' :
               s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </button>
          ))}
        </div>
      )}

      {filteredFlags.length === 0 ? (
        <div className="surface">
          <div className="empty-state" style={{ padding: '32px 24px' }}>
            <i className="ti ti-shield-check empty-state-icon" style={{ color: 'var(--green-mid)' }} />
            <p className="empty-state-title">No scope flags</p>
            <p className="empty-state-sub">{isActive ? 'Guardian is monitoring. All clear so far.' : 'Activate Guardian by sending and getting your SOW signed.'}</p>
          </div>
        </div>
      ) : (
        filteredFlags.map((flag: any) => (
          <FlagCard key={flag.id} flag={flag} permissions={permissions} router={router} projectId={project.id} />
        ))
      )}
    </div>
  )
}

function FlagCard({ flag, permissions, router, projectId }: any) {
  const [acting, setActing] = useState(false)

  async function handleAction(action: string) {
    setActing(true)
    try {
      const res  = await fetch(`/api/guardian/flags/${flag.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, projectId }),
      })
      const json = await res.json().catch(() => ({}))
      // FIX: draft_co creates a real, editable CO — but this just did
      // router.refresh() and left the user on the Guardian tab with no way
      // to find it. Take them straight to the new draft.
      if (action === 'draft_co' && json.coId) {
        router.push(`/projects/${projectId}/co/${json.coId}`)
        return
      }
      router.refresh()
    } finally { setActing(false) }
  }

  return (
    <div className={`flag-card severity-${flag.severity}`} style={{ marginBottom: 8 }}>
      <div className="flag-body">
        <div className="flag-header">
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span className={`flag-severity ${flag.severity}`}>{flag.severity} scope flag</span>
              <span className={`pill pill-${flagPill(flag.status)} pill-sm`}>{flagStatusLabel(flag.status)}</span>
              {flag.escalated_to && <span className="pill pill-purple pill-sm">Escalated</span>}
            </div>
            <p className="flag-desc">{flag.description}</p>
            <p className="flag-ref">Ref: {flag.sow_reference} · {formatRelative(flag.created_at)}</p>
          </div>
          {flag.status === 'open' && (
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {permissions.createCo && (
                <button className="btn btn-primary btn-xs" onClick={() => handleAction('draft_co')} disabled={acting}>
                  <i className="ti ti-plus" style={{ fontSize: 11 }} /> Draft CO
                </button>
              )}
              {permissions.approveFlags && (
                <button className="btn btn-ghost btn-xs" onClick={() => handleAction('resolve')} disabled={acting}>Resolve</button>
              )}
              {permissions.grantExceptions && (
                <button className="btn btn-ghost btn-xs" onClick={() => handleAction('exception')} disabled={acting}>Exception</button>
              )}
            </div>
          )}
          {/* FIX (re-audit, Guardian ghost-feature finding): confirm_out_of_
              scope/dismiss_borderline have existed as flag actions since a
              prior fix round, but nothing in this UI ever rendered a button
              for status === 'borderline_review' — every borderline flag
              was a dead end no one could act on. */}
          {flag.status === 'borderline_review' && permissions.approveFlags && (
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button className="btn btn-primary btn-xs" onClick={() => handleAction('confirm_out_of_scope')} disabled={acting}>
                Confirm out of scope
              </button>
              <button className="btn btn-ghost btn-xs" onClick={() => handleAction('dismiss_borderline')} disabled={acting}>
                Dismiss
              </button>
            </div>
          )}
        </div>
        <FlagCollaboration
          entityType="flag"
          entityId={flag.id}
          canWrite={permissions.approveFlags || permissions.grantExceptions}
        />
      </div>
    </div>
  )
}

// ── CO TAB ────────────────────────────────────────────────────
function CoTab({ project, cos, permissions, currency, pendingApprovals, team }: any) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div className="sec-title">Change orders ({cos.length})</div>
        {permissions.createCo && project.status === 'Active' && (
          <Link href={`/projects/${project.id}/co/new`}>
            <button className="btn btn-primary btn-sm"><i className="ti ti-plus" style={{ fontSize: 12 }} /> New CO</button>
          </Link>
        )}
      </div>
      {cos.length === 0 ? (
        <div className="surface">
          <div className="empty-state" style={{ padding: '32px 24px' }}>
            <i className="ti ti-git-merge empty-state-icon" />
            <p className="empty-state-title">No change orders yet</p>
            <p className="empty-state-sub">Change orders appear here when scope flags are escalated or created manually.</p>
          </div>
        </div>
      ) : (
        cos.map((co: any) => (
          <CoCard key={co.id} co={co} currency={currency} permissions={permissions} projectId={project.id}
            pendingApproval={pendingApprovals?.[`co:${co.id}`]} team={team} />
        ))
      )}
    </div>
  )
}

function EscalateCoModal({ co, team, onClose, onDone }: any) {
  const [escalateTo, setEscalateTo] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (note.trim().length < 10) { setError('Note must be at least 10 characters.'); return }
    setBusy(true); setError('')
    try {
      const res  = await fetch(`/api/co/${co.id}/escalate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escalateTo: escalateTo || null, escalationNote: note.trim() }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok) onDone()
      else setError(json.error || 'Could not escalate — try again.')
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Escalate change order</h2>
        <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
          Flag &ldquo;{co.title}&rdquo; for someone to step in. This doesn&rsquo;t change its status — it&rsquo;s just a heads-up.
        </p>
        <label className="form-label">Escalate to</label>
        <select className="form-input" value={escalateTo} onChange={(e) => setEscalateTo(e.target.value)} style={{ marginBottom: 12 }}>
          <option value="">Myself</option>
          {(team || []).map((t: any) => {
            const u = t.workspace_members?.users
            return u ? <option key={t.workspace_members.id} value={t.workspace_members.id}>{u.name}</option> : null
          })}
        </select>
        <label className="form-label">Why is this being escalated?</label>
        <textarea className="form-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Client has gone quiet for 2 weeks despite two reminders…" />
        {error && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
            {busy ? <span className="spin" /> : 'Escalate'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CoCard({ co, currency, permissions, projectId, pendingApproval, team }: any) {
  const router = useRouter()
  const [acting, setActing] = useState(false)
  const [reminded, setReminded] = useState(false)
  const [escalating, setEscalating] = useState(false)

  // FIX (section-10 audit, 10-B5): `res.ok` was never checked. Withdraw,
  // close and accept-counter all fell through to router.refresh()
  // regardless of outcome — a 403, 400 or 409 produced a page refresh
  // showing nothing had changed and no error anywhere on screen.
  //
  // FIX (section-10 audit, 10-B6): the pendingApproval branch only fired
  // for 'send', so accepting a counter that trips a co_counter workflow
  // looked identical to one that went straight to the client.
  const [actionError, setActionError] = useState('')
  async function doAction(action: string) {
    setActing(true); setActionError('')
    try {
      const res  = await fetch(`/api/co/${co.id}/${action}`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(json?.error || 'That action failed. Please try again.'); return }
      if (json?.pendingApproval) {
        alert(action === 'accept-counter'
          ? 'Sent for approval — the client will be asked to countersign the negotiated amount once it\u2019s signed off.'
          : 'Sent for approval — this CO will go to the client automatically once it\u2019s signed off.')
      }
      router.refresh()
    } catch {
      setActionError('That action failed. Please try again.')
    } finally { setActing(false) }
  }

  // Revise creates a NEW draft CO and we want to land the user in it, so
  // it gets its own handler rather than going through doAction's refresh.
  async function revise() {
    setActing(true); setActionError('')
    try {
      const res  = await fetch(`/api/co/${co.id}/revise`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(json?.error || 'Could not create a revision.'); return }
      router.push(`/projects/${projectId}/co/${json.coId}`)
    } catch {
      setActionError('Could not create a revision.')
    } finally { setActing(false) }
  }

  async function remind() {
    setActing(true); setActionError('')
    try {
      const res  = await fetch(`/api/co/${co.id}/remind`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      // FIX (section-10 audit, 10-B5): a failed reminder (cooldown, wrong
      // status, expired link) showed nothing at all.
      if (!res.ok) { setActionError(json?.error || 'Could not send that reminder.'); return }
      setReminded(true); setTimeout(() => setReminded(false), 3000)
    } catch {
      setActionError('Could not send that reminder.')
    } finally { setActing(false) }
  }

  return (
    <div className="surface surface-p" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{co.title}</span>
            <span className={`pill pill-${coPill(co.status)}`}>{coStatusLabel(co.status)}</span>
            {pendingApproval && (
              <span className="pill pill-amber">
                <i className="ti ti-shield-check" style={{ fontSize: 10 }} /> Awaiting approval ({pendingApproval.current_step}/{pendingApproval.total_steps})
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {co.document_number ? `${co.document_number} · ` : ''}v{co.version}
            {co.sent_at && <> · Sent {formatDate(co.sent_at)}</>}
            {co.accepted_at && <> · Accepted {formatDate(co.accepted_at)}</>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {permissions.viewFinancials && (
            <span style={{ fontSize: 14, fontWeight: 500, fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrency(co.total, currency)}</span>
          )}
          {co.status === 'draft' && permissions.sendCo && !pendingApproval && (
            <button className="btn btn-primary btn-xs" onClick={() => doAction('send')} disabled={acting}>Send</button>
          )}
          {co.status === 'draft' && pendingApproval && (
            <Link href="/approvals"><button className="btn btn-ghost btn-xs">Awaiting approval</button></Link>
          )}
          {co.status === 'awaiting_response' && (
            <button className="btn btn-ghost btn-xs" onClick={() => doAction('withdraw')} disabled={acting}>Withdraw</button>
          )}
          {/* FIX (doc-completeness audit, migration 014): CO is waiting on
              the client's countersignature at the negotiated total — the
              agency can still withdraw it, same as awaiting_response. */}
          {co.status === 'awaiting_countersignature' && (
            <button className="btn btn-ghost btn-xs" onClick={() => doAction('withdraw')} disabled={acting}>Withdraw</button>
          )}
          {/* FIX (section-10 audit, 10-G3): "Negotiate" linked straight to
              CoEditor, which sets isLocked = status !== 'draft' — so a
              declined CO opened fully read-only, under a banner telling
              the user to "Withdraw it to edit" when withdraw isn't even
              permitted from 'declined'. The one labelled recovery path
              from a client decline was a dead button. Revise clones the
              CO into a fresh editable draft instead. */}
          {['declined', 'withdrawn', 'closed'].includes(co.status) && permissions.createCo && (
            <button className="btn btn-ghost btn-xs" onClick={revise} disabled={acting}>
              Revise &amp; resend
            </button>
          )}
          {co.status === 'countered' && permissions.sendCo && (
            <button className="btn btn-primary btn-xs" onClick={() => doAction('accept-counter')} disabled={acting}>Accept counter</button>
          )}
          {co.status === 'countered' && permissions.createCo && (
            <button className="btn btn-ghost btn-xs" onClick={revise} disabled={acting}>
              Counter back
            </button>
          )}
          {/* FIX (re-audit, cron/portal section): 'stalled' now allowed —
              a CO auto-stalled by the co-stall cron used to have no way
              back except Close or Escalate. remind() un-stalls it server
              side (see api/co/[id]/remind/route.ts) before sending. */}
          {['awaiting_response', 'awaiting_countersignature', 'stalled'].includes(co.status) && permissions.sendCo && (
            <button className="btn btn-ghost btn-xs" onClick={remind} disabled={acting}>
              {reminded ? <><i className="ti ti-check" style={{ fontSize: 12 }} /> Sent</> : (co.status === 'stalled' ? 'Try again' : 'Remind')}
            </button>
          )}
          {['countered','stalled','declined'].includes(co.status) && (
            <button className="btn btn-ghost btn-xs" onClick={() => doAction('close')} disabled={acting}>Close</button>
          )}
          {permissions.sendCo && !['closed', 'accepted', 'withdrawn'].includes(co.status) && (
            <button className="btn-icon" title="Escalate" onClick={() => setEscalating(true)}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 13 }} />
            </button>
          )}
          <Link href={`/projects/${projectId}/co/${co.id}`}>
            <button className="btn-icon"><i className="ti ti-eye" style={{ fontSize: 13 }} /></button>
          </Link>
        </div>
      </div>
      {/* FIX (section-10 audit, 10-G1): the counter-offer the agency is
          being asked to accept was invisible. counter_amount and
          counter_note lived in the database and were read by the
          accept-counter route, but appeared in no component — the card
          showed the ORIGINAL total right next to a primary "Accept
          counter" button. Show the number and the client's reasoning
          before anyone commits to it. */}
      {co.status === 'countered' && (
        <div style={{
          marginTop: 10, padding: '10px 12px', borderRadius: 6,
          background: 'var(--surface-2)', borderLeft: '3px solid var(--amber)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-3)', marginBottom: 6 }}>
            Client counter-offer
          </div>
          {permissions.viewFinancials && co.counter_amount != null && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-3)' }}>Proposed total</span>
              <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600 }}>
                {formatCurrency(co.counter_amount, currency)}
                {co.total != null && (
                  <span style={{ color: 'var(--text-3)', fontWeight: 400, marginLeft: 8 }}>
                    (was {formatCurrency(co.total, currency)})
                  </span>
                )}
              </span>
            </div>
          )}
          {co.counter_note && (
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6, marginTop: 4 }}>
              &ldquo;{co.counter_note}&rdquo;
            </div>
          )}
        </div>
      )}
      {(co.declined_reason || co.close_reason) && ['declined', 'closed'].includes(co.status) && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
          {co.status === 'declined' ? 'Client declined: ' : 'Closed: '}
          <span style={{ color: 'var(--text-2)' }}>{co.declined_reason || co.close_reason}</span>
        </div>
      )}
      {actionError && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--red)' }}>{actionError}</div>
      )}
      {escalating && (
        <EscalateCoModal co={co} team={team} onClose={() => setEscalating(false)}
          onDone={() => { setEscalating(false); router.refresh() }} />
      )}
    </div>
  )
}

// ── ACTIVITY TAB ──────────────────────────────────────────────
function ActivityTab({ activity }: { activity: any[] }) {
  function eventColour(type: string) {
    if (type.includes('signed') || type.includes('accepted') || type.includes('completed')) return 'var(--green)'
    if (type.includes('declined') || type.includes('stalled') || type.includes('failed')) return 'var(--red)'
    if (type.includes('flag') || type.includes('guardian')) return 'var(--amber)'
    return 'var(--blue)'
  }
  return (
    <div>
      {activity.length === 0 ? (
        <div className="surface">
          <div className="empty-state" style={{ padding: '32px 24px' }}>
            <i className="ti ti-clock empty-state-icon" />
            <p className="empty-state-title">No activity yet</p>
          </div>
        </div>
      ) : (
        <div className="surface surface-p">
          {activity.map((a: any) => (
            <div key={a.id} className="feed-item">
              <div className="feed-dot" style={{ background: eventColour(a.event_type), marginTop: 6 }} />
              <div className="feed-body">
                <div className="feed-text">
                  <strong>{a.actor_name}</strong> · {a.event_type.replace(/\./g, ' ').replace(/_/g, ' ')}
                  {a.entity_name && <> on <em>{a.entity_name}</em></>}
                </div>
                <div className="feed-time">{formatRelative(a.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── TEAM TAB ──────────────────────────────────────────────────
// C14: "Add member" button now loads available members and opens a modal.
function TeamTab({ project, team, permissions }: any) {
  const router = useRouter()
  const [adding,       setAdding]       = useState(false)
  const [available,    setAvailable]    = useState<any[]>([])
  const [loadingModal, setLoadingModal] = useState(false)
  const [addingId,     setAddingId]     = useState<string | null>(null)

  async function openAddModal() {
    setLoadingModal(true)
    try {
      const res  = await fetch(`/api/projects/${project.id}/members/available`)
      const json = await res.json()
      setAvailable(json.members || [])
      setAdding(true)
    } finally { setLoadingModal(false) }
  }

  const [addError, setAddError] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)

  async function addMember(memberId: string) {
    setAddingId(memberId); setAddError('')
    try {
      const res  = await fetch(`/api/projects/${project.id}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok) { setAdding(false); router.refresh() }
      else setAddError(json.error || 'Could not add that member — try again.')
    } finally { setAddingId(null) }
  }

  // FIX (deep audit, section 7): there was previously no way to remove a
  // member from a project short of deactivating them from the whole
  // workspace.
  async function removeMember(memberId: string, name: string) {
    if (!confirm(`Remove ${name} from this project?`)) return
    setRemovingId(memberId)
    try {
      const res = await fetch(`/api/projects/${project.id}/members`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId }),
      })
      if (res.ok) router.refresh()
    } finally { setRemovingId(null) }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div className="sec-title">Project team ({team.length})</div>
        {permissions.assignTeam && (
          <button className="btn btn-ghost btn-sm" onClick={openAddModal} disabled={loadingModal}>
            {loadingModal ? <span className="spin spin-dark" /> : <><i className="ti ti-plus" style={{ fontSize: 12 }} /> Add member</>}
          </button>
        )}
      </div>

      {team.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No members assigned to this project yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {team.map((t: any) => {
            const u = t.workspace_members?.users
            return u ? (
              <div key={t.id} className="surface surface-p" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFF', fontSize: 12, fontWeight: 600 }}>
                  {u.name?.split(' ').map((p: string) => p[0]).join('').toUpperCase().slice(0, 2)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{u.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{u.email}</div>
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Added {formatDate(t.added_at)}</span>
                {permissions.assignTeam && (
                  <button className="btn-icon" style={{ color: 'var(--red)' }}
                    disabled={removingId === t.workspace_members?.id}
                    onClick={() => removeMember(t.workspace_members?.id, u.name)}>
                    {removingId === t.workspace_members?.id ? <span className="spin spin-dark" /> : <i className="ti ti-x" style={{ fontSize: 13 }} />}
                  </button>
                )}
              </div>
            ) : null
          })}
        </div>
      )}

      {/* C14: Add member modal */}
      {adding && (
        <>
          <div className="modal-bg" onClick={() => setAdding(false)} />
          <div className="modal">
            <h2 className="modal-title">Add team member</h2>
            <p className="modal-sub">Select a workspace member to assign to this project.</p>
            {addError && <p className="ferr" style={{ marginBottom: 10 }}>{addError}</p>}
            {available.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-3)', padding: '16px 0' }}>
                All workspace members are already on this project.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {available.map((m: any) => {
                  const u = m.users
                  return (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                      onClick={() => addMember(m.id)}>
                      <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFF', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                        {u?.name?.split(' ').map((p: string) => p[0]).join('').toUpperCase().slice(0, 2) || '?'}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{u?.name || '—'}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{u?.email} · {m.roles?.name || 'No role'}</div>
                      </div>
                      {addingId === m.id
                        ? <span className="spin spin-dark" />
                        : <i className="ti ti-plus" style={{ fontSize: 13, color: 'var(--green)' }} />}
                    </div>
                  )
                })}
              </div>
            )}
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setAdding(false)}>Close</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
