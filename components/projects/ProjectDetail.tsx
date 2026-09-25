// components/projects/ProjectDetail.tsx
// C14: TeamTab "Add member" button wired — loads available members,
//      shows modal, posts to /api/projects/[id]/members

'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { SessionUser } from '@/lib/supabase/types'
import type { ShapedActivity } from '@/lib/utils/activity-format'
import BillingTab from '@/components/invoices/BillingTab'
import FlagCollaboration from './FlagCollaboration'
import ProjectDiscussion from './ProjectDiscussion'
import EditProjectModal from './EditProjectModal'
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
    // FIX (CO-logic fix round): 'expired' fell through to the default
    // ('slate') here — the same neutral grey as draft/closed/withdrawn —
    // even though it's meant to read as alarming, same as declined/
    // stalled, and matches lib/utils/format.ts's own
    // CO_STATUS_COLOURS.expired ('badge-red').
    expired: 'red',
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
  editProject: boolean
}

interface Props {
  project: any
  milestones: any[]
  amendments: any[]
  team: any[]
  activity: ShapedActivity[]
  activityHasMore?: boolean
  invoices: any[]
  reconciliation: any[]
  defaultPaymentInstructions?: string
  billingDefaults?: { taxRate: number; taxInclusive: boolean; paymentTermsDays: number | null }
  // Shared definition (lib/utils/contract-value.ts). All null when the viewer lacks VIEW_FINANCIALS.
  effectiveContractValue: number | null
  baseContractValue: number | null
  amendmentImpact: number | null
  initialTab: string
  isNewProject: boolean
  session: SessionUser
  permissions: Permissions
  // Phase 3 — Approval Chains: keyed by "sow:<id>" / "co:<id>", present
  // only for documents currently held on a pending approval chain.
  pendingApprovals?: Record<string, { id: string; current_step: number; total_steps: number; sendFailed?: boolean; sendFailedReason?: string | null }>
}

export default function ProjectDetail({
  project, milestones, amendments, team, activity, activityHasMore = false, invoices, reconciliation,
  effectiveContractValue: effectiveContractValueProp, baseContractValue: baseContractValueProp, amendmentImpact: amendmentImpactProp, initialTab, permissions, pendingApprovals = {}, session,
  defaultPaymentInstructions = '', billingDefaults,
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

  // Computed once server-side from the shared definition (retainer term value; retainer-renewal
  // amendments excluded) — this used to re-sum every amendment here, which double-counted legacy
  // renewals and treated a retainer's monthly rate as its whole value.
  const effectiveContractValue = effectiveContractValueProp ?? 0
  const recoveredAmt  = amendmentImpactProp ?? 0
  const isRetainer    = project.type === 'retainer'
  const monthlyRate   = isRetainer ? (Number(project.contract_value) || 0) : null
  // FIX (doc-completeness audit, migration 014)
  // 'stalled' = sent, unanswered: still exposure. contract-position (reconciliation) and the Portfolio
  // both count it; this header didn't, so the three disagreed about the same change orders.
  // FIX (Projects & Dashboard independent pass): 'expired' was still missing here even though this
  // same file's handleMarkComplete (below), the complete route's BLOCKING_CO_STATUSES, and
  // lib/utils/attention.ts's actionableCoStatuses all already treat an expired CO — its signing link
  // died with no answer given — as exactly as unresolved as a stalled one. Left out, this tile silently
  // undercounted "at risk" the moment a CO's link expired, and disagreed with every other screen that
  // already got this right.
  const openCos       = (project.change_orders || []).filter((co: any) => ['awaiting_response','countered','stalled','awaiting_countersignature','expired'].includes(co.status))
  const atRiskAmt     = openCos.reduce((s: number, co: any) => s + (co.total || 0), 0)
  const baseValue     = baseContractValueProp ?? 0
  // FIX (re-audit, Guardian ghost-feature finding): this badge only ever
  // counted status === 'open', so a borderline_review flag — which needs a
  // human to confirm or dismiss it just as much as an open flag needs
  // resolving — raised zero visual signal anywhere in the product.
  const openFlagCount = (project.guardian_flags || []).filter(
    (f: any) => f.status === 'open' || f.status === 'borderline_review'
  ).length

  async function handleMarkComplete() {
    // FIX (section-10 audit, feature gap — CO expiry): 'expired' added —
    // an expired CO is just as unresolved as a stalled or awaiting one
    // (neither accepted nor closed out), so it should block "mark
    // complete" the same way, not silently let a project close out with
    // a dead, unresolved change order sitting on it.
    const blockingCos = (project.change_orders || []).filter((co: any) =>
      ['awaiting_response','countered','stalled','awaiting_countersignature','expired'].includes(co.status)
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
  // ── Edit / pause / resume / reopen (Projects & Dashboard deep audit) ──
  // The API for all four existed (PATCH status Active<->Stalled, PATCH details,
  // and — new — POST /reopen) but the page offered no control for any of them:
  // a project could not be edited, manually paused, or reopened after a
  // mis-clicked "Mark complete".
  const [editing, setEditing] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [reopening, setReopening] = useState(false)
  const isTerminal = ['Complete', 'Archived'].includes(project.status)
  const hasSignedSow = (project.sow_documents || []).some((s: any) => s.status === 'signed')
  // A project stalled because its SOW was never signed resumes when the SOW is
  // signed/resent — not by hand (the API refuses it, so don't offer it).
  const canResume = project.status === 'Stalled' && (project.stall_reason === 'manual' || hasSignedSow)
  const canPause = project.status === 'Active'

  async function handlePauseResume(next: 'Stalled' | 'Active') {
    const msg = next === 'Stalled'
      ? `Pause "${project.name}"? Forwarded client emails are not checked by Guardian while it's paused (you can still check content by hand from the Guardian tab), and the project shows as paused.`
      : `Resume "${project.name}"? Guardian starts checking forwarded client emails again — anything received while paused is not back-checked.`
    if (!confirm(msg)) return
    setPausing(true); setError('')
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Something went wrong')
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setPausing(false) }
  }

  async function handleReopen() {
    if (!confirm(`Reopen "${project.name}"? It returns to Active and Guardian monitoring restarts. Flags that were auto-closed at completion stay closed.`)) return
    setReopening(true); setError('')
    try {
      const res = await fetch(`/api/projects/${project.id}/reopen`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Something went wrong')
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setReopening(false) }
  }

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
            {permissions.editProject && !isTerminal && (
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                <i className="ti ti-pencil" style={{ fontSize: 12 }} /> Edit
              </button>
            )}
            {permissions.editProject && canPause && (
              <button className="btn btn-ghost btn-sm" onClick={() => handlePauseResume('Stalled')} disabled={pausing}>
                {pausing ? <span className="spin spin-dark" /> : <><i className="ti ti-player-pause" style={{ fontSize: 12 }} /> Pause</>}
              </button>
            )}
            {permissions.editProject && canResume && (
              <button className="btn btn-ghost btn-sm" onClick={() => handlePauseResume('Active')} disabled={pausing}>
                {pausing ? <span className="spin spin-dark" /> : <><i className="ti ti-player-play" style={{ fontSize: 12 }} /> Resume</>}
              </button>
            )}
            {permissions.markComplete && project.status === 'Complete' && (
              <button className="btn btn-ghost btn-sm" onClick={handleReopen} disabled={reopening}>
                {reopening ? <span className="spin spin-dark" /> : <><i className="ti ti-arrow-back-up" style={{ fontSize: 12 }} /> Reopen</>}
              </button>
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
        {editing && (
          <EditProjectModal
            project={project}
            canViewFinancials={permissions.viewFinancials}
            onClose={() => setEditing(false)}
            onSaved={() => { setEditing(false); router.refresh() }}
          />
        )}

        {permissions.viewFinancials && (
          <div style={{ display: 'flex', gap: 28, marginBottom: 16, flexWrap: 'wrap' }}>
            {monthlyRate != null && (
              <MetricBlock label="Monthly rate" value={`${formatCurrency(monthlyRate, currency)}/mo`} />
            )}
            <MetricBlock label={isRetainer ? (project.retainer_duration_months > 0 ? 'Original term value' : 'Contracted to date') : 'Original value'} value={formatCurrency(baseValue, currency)} />
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
        {tab === 'overview' && <OverviewTab project={project} milestones={milestones} amendments={amendments} permissions={permissions} currency={currency} router={router} baseValue={baseValue} />}
        {tab === 'sow'      && <SowTab project={project} sows={project.sow_documents || []} amendments={amendments} permissions={permissions} router={router} pendingApprovals={pendingApprovals} />}
        {tab === 'guardian' && <GuardianTab project={project} flags={project.guardian_flags || []} exceptions={project.exceptions_log || []} permissions={permissions} router={router} team={team} />}
        {tab === 'co'       && <CoTab project={project} cos={project.change_orders || []} permissions={permissions} currency={currency} pendingApprovals={pendingApprovals} team={team} />}
        {tab === 'billing'  && <BillingTab project={project} milestones={milestones} invoices={invoices} reconciliation={reconciliation} permissions={permissions} currency={currency} router={router} defaultPaymentInstructions={defaultPaymentInstructions} billingDefaults={billingDefaults} pendingApprovals={pendingApprovals} />}
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
        {tab === 'activity' && <ActivityTab projectId={project.id} initial={activity} initialHasMore={activityHasMore} />}
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

// FEATURE (deep audit, section 13 — feature gap): `field` distinguishes an
// in-scope deliverable from an "Excluded" (out_of_scope) entry — see
// api/guardian/scope-adjustment's own comment for the backend half of this.
// Defaults to 'deliverables' so the existing deliverable-adjust callers
// don't need to change.
function ScopeAdjustModal({ projectId, deliverable, field = 'deliverables', onClose, onDone }: any) {
  const [newValue, setNewValue] = useState(deliverable)
  const [reason, setReason]     = useState('')
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')
  const isExcluded = field === 'out_of_scope'
  const noun = isExcluded ? 'excluded item' : 'deliverable'

  async function submit() {
    if (!newValue.trim() || !reason.trim()) { setError('Both fields are required.'); return }
    setBusy(true); setError('')
    try {
      const res  = await fetch('/api/guardian/scope-adjustment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, deliverable, field, oldValue: deliverable, newValue: newValue.trim(), reason: reason.trim() }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok) onDone()
      else setError(json.error || 'Could not save that adjustment.')
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Adjust {noun}</h2>
        <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
          Corrects the scope snapshot directly — for fixing a typo or wording issue, not for adding/removing scope. Real scope changes still go through a change order.
        </p>
        <label className="form-label">{isExcluded ? 'Excluded item' : 'Deliverable'}</label>
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
function OverviewTab({ project, milestones, amendments, permissions, currency, router, baseValue }: any) {
  const isRetainer = project.type === 'retainer'
  // FIX: one-to-one relation (see /api/guardian/check for details) — no [0]
  const snapshot     = project.project_scope_snapshot
  const deliverables = snapshot?.deliverables || []
  const outOfScope   = snapshot?.out_of_scope || []
  const sowDocs      = project.sow_documents || []
  // FEATURE (deep audit, section 13 — feature gap): now tracks which list
  // (deliverables vs out_of_scope) the item being adjusted came from — see
  // ScopeAdjustModal and api/guardian/scope-adjustment for the rest of this.
  const [adjusting, setAdjusting] = useState<{ value: string; field: 'deliverables' | 'out_of_scope' } | null>(null)
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
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>{isRetainer ? 'Monthly retainer rate' : 'Contract value'}</div>
                <div style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                  {formatCurrency(project.contract_value || 0, currency)}{isRetainer ? '/mo' : ''}
                  {isRetainer && (
                    <span style={{ fontFamily: 'inherit', fontSize: 11, color: 'var(--text-3)' }}>
                      {project.retainer_duration_months > 0
                        ? ` · ${formatCurrency(baseValue, currency)} over ${project.retainer_duration_months} months`
                        : ` · open-ended (${formatCurrency(baseValue, currency)} contracted so far)`}
                    </span>
                  )}
                </div>
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
                      <button className="btn-icon" title="Adjust wording" onClick={() => setAdjusting({ value: d.title || d, field: 'deliverables' })}>
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
                {/* FEATURE (deep audit, section 13 — feature gap): excluded
                    entries had no correction path at all — only deliverables
                    got the "Adjust wording" pencil above, even though a typo
                    here is just as likely and lives in the same snapshot row.
                    See ScopeAdjustModal and api/guardian/scope-adjustment. */}
                {outOfScope.map((d: any, i: number) => (
                  <div key={i} className="scope-entry" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="scope-glyph out"><i className="ti ti-x" style={{ fontSize: 9 }} /></div>
                      <span style={{ color: 'var(--text-2)' }}>{d.title || d}</span>
                    </div>
                    {permissions.editSow && (
                      <button className="btn-icon" title="Adjust wording" onClick={() => setAdjusting({ value: d.title || d, field: 'out_of_scope' })}>
                        <i className="ti ti-pencil" style={{ fontSize: 11 }} />
                      </button>
                    )}
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
                    <span style={{ color: a.financial_impact < 0 ? 'var(--red)' : 'var(--green)', fontFamily: 'IBM Plex Mono, monospace' }}>
                      {a.financial_impact < 0 ? '−' : '+'}{formatCurrency(Math.abs(a.financial_impact), currency)}
                    </span>
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
      {adjusting !== null && (
        <ScopeAdjustModal projectId={project.id} deliverable={adjusting.value} field={adjusting.field}
          onClose={() => setAdjusting(null)}
          onDone={() => { setAdjusting(null); router.refresh() }} />
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
  // FIX (fix round, section-11 flagship finding): before this, the only
  // place a fully-approved-but-send-failed SOW was ever surfaced was a
  // one-time email/notification to whoever happened to be the original
  // requester — nothing on the project's own SOW tab showed it, and there
  // was no way to retry from here at all. See pendingApprovals fetch in
  // app/(app)/projects/[id]/page.tsx for the matching query-side fix.
  const [retrying, setRetrying] = useState(false)
  async function handleRetrySend(approvalRequestId: string) {
    setRetrying(true); setError('')
    try {
      const res  = await fetch(`/api/approvals/${approvalRequestId}/retry-send`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Retry failed')
      // Approved and sent, but the mail provider rejected the client email.
      if (json.deliveryWarning) alert(json.deliveryWarning)
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Retry failed')
    } finally { setRetrying(false) }
  }
  // FIX (section-11 audit, pass 2): a draft SOW whose approval finished but whose send
  // failed could be retried but never released — it stayed edit-locked, and unlike a
  // CO or invoice a SOW has no delete/void route to get out. Cancelling the request
  // makes it an ordinary editable draft again (sending it afterwards needs a new approval).
  async function handleCancelApproval(approvalRequestId: string) {
    if (!confirm('Cancel this approved request? The SOW goes back to being an editable draft, and sending it again will need a fresh approval.')) return
    setRetrying(true); setError('')
    try {
      const res  = await fetch(`/api/approvals/${approvalRequestId}/cancel`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not cancel the request')
      window.dispatchEvent(new Event('scopegov:approvals-changed'))
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not cancel the request')
    } finally { setRetrying(false) }
  }
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

  const [notice, setNotice] = useState('')

  async function handleSendSow() {
    setSending(true); setError(''); setNotice(''); setSentForApproval(false)
    try {
      const post = async (acknowledgeWarnings: boolean) => {
        const res = await fetch(`/api/sow/${currentSow.id}/send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ acknowledgeWarnings }),
        })
        return { res, json: await res.json().catch(() => ({} as any)) }
      }
      let { res, json } = await post(false)
      // Soft warnings (e.g. Payment Terms text doesn't state the contract value) need a human "yes".
      if (res.status === 409 && json.needsAcknowledgement) {
        const list: string[] = Array.isArray(json.warnings) && json.warnings.length ? json.warnings : [json.error]
        if (!confirm(`${list.join('\n\n')}\n\nSend it anyway?`)) return
        ;({ res, json } = await post(true))
      }
      if (!res.ok) throw new Error(json.error || 'Failed to send')
      if (json.pendingApproval) setSentForApproval(true)
      // The mail provider can reject a send without the request failing; say so instead of
      // implying the client has the link.
      if (json.emailSent === false)
        setNotice(`Marked as sent, but the email to the client could not be delivered (${json.emailError || 'provider error'}). Use "Copy signing link" and send it to them yourself.`)
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send SOW')
    } finally { setSending(false) }
  }

  async function handleCopyLink() {
    setError(''); setNotice('')
    try {
      const res  = await fetch(`/api/sow/${currentSow.id}/link`)
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json.error || 'Could not get the signing link')
      try { await navigator.clipboard.writeText(json.portalUrl); setNotice('Signing link copied to your clipboard.') }
      catch { window.prompt('Copy this signing link:', json.portalUrl) }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not get the signing link')
    }
  }

  // FIX (fix round, SOW-G1): generalized to take an explicit sowId (default:
  // currentSow, unchanged for every existing caller) so the version-history
  // row below can withdraw a `changes_requested` SOW specifically — the API
  // has always allowed this (WITHDRAWABLE_FROM includes 'changes_requested'),
  // but nothing in the UI could ever reach it, since a changes_requested SOW
  // is never `currentSow` (request-changes always spawns a newer draft on
  // top of it) and the version-history list only ever offered View/PDF.
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)
  async function handleWithdraw(sowId: string = currentSow.id) {
    if (!confirm('Withdraw this SOW? The client link will be deactivated.')) return
    setError(''); setWithdrawingId(sowId)
    try {
      const res  = await fetch(`/api/sow/${sowId}/withdraw`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setError(json.error || 'Failed to withdraw'); return }
      router.refresh()
    } catch {
      setError('Failed to withdraw')
    } finally {
      setWithdrawingId(null)
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
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json.error || 'Failed to send reminder')
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send reminder')
    } finally { setReminding(false) }
  }

  return (
    <div>
      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="surface surface-p" style={{ marginBottom: 14, borderLeft: '3px solid var(--amber)', fontSize: 13, color: 'var(--text-2)' }}>{notice}</div>}
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
                    {pendingApproval && pendingApproval.sendFailed && (
                      <span className="pill pill-red" title={pendingApproval.sendFailedReason || undefined}>
                        <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} /> Approved — not sent
                      </span>
                    )}
                    {pendingApproval && !pendingApproval.sendFailed && (
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
                  {currentSow.status === 'draft' && pendingApproval && pendingApproval.sendFailed && permissions.sendSow && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => handleCancelApproval(pendingApproval.id)} disabled={retrying}>
                        Cancel request
                      </button>
                      <button className="btn btn-primary btn-sm" onClick={() => handleRetrySend(pendingApproval.id)} disabled={retrying}>
                        {retrying ? <span className="spin" /> : <><i className="ti ti-refresh" style={{ fontSize: 12 }} /> Retry send</>}
                      </button>
                    </>
                  )}
                  {currentSow.status === 'draft' && pendingApproval && !pendingApproval.sendFailed && (
                    <Link href={`/approvals?highlight=${pendingApproval.id}`}>
                      <button className="btn btn-ghost btn-sm"><i className="ti ti-shield-check" style={{ fontSize: 12 }} /> Awaiting approval</button>
                    </Link>
                  )}
                  {currentSow.status === 'awaiting_signature' && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={handleRemind} disabled={reminding}>
                        {reminding ? <span className="spin" /> : <><i className="ti ti-refresh" style={{ fontSize: 12 }} /> Remind</>}
                      </button>
                      {permissions.sendSow && (
                        <button className="btn btn-ghost btn-sm" onClick={handleCopyLink}><i className="ti ti-link" style={{ fontSize: 12 }} /> Copy signing link</button>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => handleWithdraw()}><i className="ti ti-x" style={{ fontSize: 12 }} /> Withdraw</button>
                    </>
                  )}
                  {['withdrawn', 'declined', 'expired'].includes(currentSow.status) && permissions.editSow && (
                    <button className="btn btn-primary btn-sm" onClick={handleReopen} disabled={reopening}>
                      {reopening
                        ? <span className="spin" />
                        : <><i className="ti ti-refresh" style={{ fontSize: 12 }} /> Start new version</>}
                    </button>
                  )}
                  {currentSow.signed_at && permissions.viewFinancials && (
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
                    {/* Every version can be opened and downloaded (unsigned ones are watermarked) —
                        a declined or withdrawn version is the record of what the client actually saw,
                        and had no way to be viewed. */}
                    <Link href={`/projects/${project.id}/sow/${s.id}`} className="btn btn-ghost btn-xs"><i className="ti ti-eye" style={{ fontSize: 11 }} /> View</Link>
                    {/* FIX (section-9 re-audit): api/pdf/sow/[id] now 403s a viewer without
                        VIEW_FINANCIALS (see that route's comment) — gate the link the same
                        way every other contract-value display in this file already does. */}
                    {permissions.viewFinancials && (
                      <a href={`/api/pdf/sow/${s.id}`} target="_blank" className="btn btn-ghost btn-xs"><i className="ti ti-download" style={{ fontSize: 11 }} /> PDF</a>
                    )}
                    {/* FIX (fix round, SOW-G1): the only reachable path to formally cancel
                        a changes_requested SOW (revoke its still-live token, notify the
                        client this thread is closed) rather than leaving it dangling
                        forever while its auto-created sibling draft sits unsent. */}
                    {s.status === 'changes_requested' && permissions.sendSow && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => handleWithdraw(s.id)}
                        disabled={withdrawingId === s.id}
                      >
                        {withdrawingId === s.id
                          ? <span className="spin" />
                          : <><i className="ti ti-x" style={{ fontSize: 11 }} /> Withdraw</>}
                      </button>
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

// FIX (SOW-lifecycle fix round): the closed set this modal's own Payment
// structure <select> below offers — kept as a real list (not just inline
// JSX) so the AI-brief-parse result can be checked against it before ever
// reaching setPaymentStructure. Must match generate/route.ts's
// PAYMENT_STRUCTURE_LABELS keys and this file's own <option> values.
const SOW_PAYMENT_STRUCTURES = ['50_50', '100_upfront', 'milestones', 'monthly', 'on_delivery']

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
      // FIX (SOW-lifecycle fix round): paymentStructure/revisionRounds came
      // straight from the AI-parsed brief with no check against the same
      // closed set / range api/sow/generate enforces server-side (the
      // prompt asks the model to pick one of 5 values and an integer 1-10,
      // but nothing enforced that on the response). paymentStructure feeds
      // a controlled <select> with exactly those 5 <option>s below — an
      // off-spec value (a capitalization slip, a hallucinated string)
      // desynced the select from its options with no visible error, and
      // the user hit a confusing "Invalid payment structure" 400 at
      // Generate for a field they never touched. An out-of-range
      // revisionRounds was silently clamped to 2 server-side while this
      // number input kept showing the original (unused) value, so the
      // generated document's revision terms could silently disagree with
      // the screen. Validate here the same way generate/route.ts does, so
      // an off-spec AI answer falls back to the existing manual default
      // instead of being trusted as-is.
      if (SOW_PAYMENT_STRUCTURES.includes(brief.paymentStructure)) setPaymentStructure(brief.paymentStructure)
      const parsedBriefRounds = Number(brief.revisionRounds)
      if (Number.isInteger(parsedBriefRounds) && parsedBriefRounds >= 1 && parsedBriefRounds <= 10)
        setRevisionRounds(String(parsedBriefRounds))
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
// Hoisted to module scope (was local to GuardianTab) so GuardianHistoryPanel
// can share the same outcome copy instead of duplicating/drifting from it.
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
  // FEATURE (independent pass, section 13): a check saved without a verdict (no signed SOW yet, or an
  // inbound rate limit) is no longer stranded — the guardian-health sweep classifies it automatically.
  queued:                { icon: 'ti-hourglass', color: 'var(--text-3)', bg: 'var(--surface-2)', title: 'Saved — will be checked automatically' },
  classification_failed: { icon: 'ti-alert-triangle', color: 'var(--red)', bg: 'var(--red-lt)', title: 'Classification failed — try again in a moment' },
}

function GuardianTab({ project, flags, exceptions = [], permissions, router, team }: any) {
  const [pasteMode,    setPasteMode]    = useState(false)
  const [pasteText,    setPasteText]    = useState('')
  const [submitting,   setSubmitting]   = useState(false)
  const [submitError,  setSubmitError]  = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  // FEATURE (deep audit, section 13 — flagship finding): ACCESS_GUARDIAN_
  // HISTORY has existed as a permission since the initial schema and was
  // already being computed into `permissions` on every project-page load
  // (see app/(app)/projects/[id]/page.tsx), but nothing in this component
  // ever read it — the panel it was supposed to gate didn't exist. See
  // GuardianHistoryPanel below and app/api/guardian/checks/route.ts.
  const [historyOpen,  setHistoryOpen]  = useState(false)
  // BUG: the check's actual verdict (in_scope / out_of_scope / duplicate /
  // pending / classification_failed) was fetched from the API and then
  // discarded — the UI just closed the paste box and silently refreshed,
  // so an in_scope/borderline result (no flag created) gave the user zero
  // feedback that anything happened at all.
  const [lastResult,   setLastResult]   = useState<any>(null)
  // FEATURE (deep audit, section 13 — feature gap): `isRetroactive` has been
  // a fully-wired param on POST /api/guardian/check since it was added —
  // accepted, used to bypass the Active/Stalled status gate, persisted to
  // guardian_checks.is_retroactive, and even rendered as a "Retroactive"
  // pill in GuardianHistoryPanel below — but nothing anywhere ever sent
  // isRetroactive: true. There was no way to use a feature that was
  // otherwise fully built. See canSubmitLive below and the two paste-mode
  // entry points it now feeds.
  const [pasteRetroactive, setPasteRetroactive] = useState(false)

  const isActive   = project.status === 'Active'
  // FIX (deep audit, section 13): the paste-check UI gated on `isActive`
  // (status === 'Active' only), but /api/guardian/check itself has always
  // allowed 'Stalled' projects too (a Stalled project still has a signed
  // scope to check content against — it's paused, not archived). That made
  // a real, backend-supported case ("run a scope check while the project
  // is stalled") completely unreachable from the UI: a Stalled project's
  // Guardian panel claimed "not yet active" and offered no paste box at
  // all. This is the actual live-monitoring gate; isActive above is now
  // only used for the pure display language ("active" vs "paused").
  const canSubmitLive = ['Active', 'Stalled'].includes(project.status)
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
        body: JSON.stringify({
          projectId: project.id, content: pasteText, source: 'paste',
          isRetroactive: pasteRetroactive,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setPasteText(''); setPasteMode(false); setPasteRetroactive(false)
      setLastResult(json)
      // Only worth a refresh if a flag was actually created — otherwise
      // there's nothing new to pull from the server.
      if (json.flagId) setTimeout(() => router.refresh(), 1500)
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed')
    } finally { setSubmitting(false) }
  }



  return (
    <div>
      <div className="surface surface-p" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 9, height: 9, borderRadius: '50%', background: isActive ? 'var(--green)' : canSubmitLive ? 'var(--amber)' : 'var(--text-4)', boxShadow: isActive ? '0 0 0 3px rgba(26,92,58,.15)' : 'none' }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {/* FIX (deep audit, section 13): 'Stalled' used to fall into the
                  same "not yet active" bucket as a project that never had a
                  scope signed at all — misleading, since a Stalled project's
                  Guardian is fully wired and checkable, just paused. */}
              {isActive ? 'Guardian active' : project.status === 'Stalled' ? 'Guardian paused' : ['Complete','Archived'].includes(project.status) ? 'Guardian inactive' : 'Guardian not yet active'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {isActive ? `Monitoring via ${project.guardian_email || 'forwarding email'}`
                : canSubmitLive ? `Paused — you can still check content against the signed scope via ${project.guardian_email || 'forwarding email'}`
                : 'Activates when client signs the SOW'}
            </div>
          </div>
        </div>
        {canSubmitLive && project.guardian_email && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 3 }}>Forward client emails to</div>
            <code style={{ fontSize: 12, background: 'var(--surface-2)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border)' }}>
              {project.guardian_email}
            </code>
          </div>
        )}
      </div>

      {(permissions.viewGuardianHistory || permissions.submitGuardian) && (
        <div style={{ display: 'flex', gap: 8, marginBottom: historyOpen ? 0 : 16 }}>
          {canSubmitLive && permissions.submitGuardian && !pasteMode && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setPasteMode(true); setPasteRetroactive(false); setLastResult(null) }}>
              <i className="ti ti-clipboard" style={{ fontSize: 12 }} /> Paste email or message
            </button>
          )}
          {/* FEATURE (deep audit, section 13 — feature gap): the retroactive
              path — a check the API has always accepted and stored, badge
              and all, for a project that isn't currently Active/Stalled —
              had no way to actually be triggered. This is that entry point:
              a project still in Draft/Intake/Awaiting Signature/Changes
              Requested/Complete/Archived can log a past message against the
              scope for the record, without it being treated as live
              monitoring. */}
          {!canSubmitLive && permissions.submitGuardian && !pasteMode && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setPasteMode(true); setPasteRetroactive(true); setLastResult(null) }}>
              <i className="ti ti-clipboard" style={{ fontSize: 12 }} /> Log a past check
            </button>
          )}
          {permissions.viewGuardianHistory && (
            <button className="btn btn-ghost btn-sm" onClick={() => setHistoryOpen(o => !o)}>
              <i className={`ti ${historyOpen ? 'ti-chevron-up' : 'ti-history'}`} style={{ fontSize: 12 }} /> Check history
            </button>
          )}
        </div>
      )}

      {permissions.viewGuardianHistory && historyOpen && (
        <GuardianHistoryPanel projectId={project.id} canRetry={permissions.submitGuardian} />
      )}

      {permissions.submitGuardian && (
        <div style={{ marginBottom: 16 }}>
          {!pasteMode ? null : (
            <div className="surface surface-p">
              <label className="flbl">
                {pasteRetroactive ? 'Log a past client message for the record' : 'Paste client message to check against scope'}
              </label>
              {pasteRetroactive && (
                <p style={{ fontSize: 11, color: 'var(--text-3)', margin: '2px 0 6px' }}>
                  This won&apos;t change the project&apos;s status or live monitoring — it just records this content against the signed scope, same as a normal check.
                </p>
              )}
              <textarea className="finp" style={{ minHeight: 100, resize: 'vertical', marginTop: 6 }}
                value={pasteText} autoFocus placeholder="Paste the client's email or message here…"
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPasteText(e.target.value)} />
              {submitError && <p className="ferr">{submitError}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-primary btn-sm" onClick={handlePasteSubmit} disabled={submitting || !pasteText.trim()}>
                  {submitting ? <span className="spin" /> : 'Check scope'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setPasteMode(false); setPasteText(''); setPasteRetroactive(false) }}>Cancel</button>
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
                  {lastResult.message && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{lastResult.message}</div>
                  )}
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
          <FlagCard key={flag.id} flag={flag} permissions={permissions} router={router} projectId={project.id} team={team} />
        ))
      )}

      {/* FEATURE (deep audit, section 13 — flagship finding): exceptions_log
          rows have existed since the initial schema, and flag_comments/
          flag_attachments (via FlagCollaboration entityType="exception")
          have supported annotating them since Phase 2 — but nothing ever
          listed a project's granted exceptions anywhere in this tab, so
          that entire collaboration surface was unreachable. The only place
          an exception was ever visible was the cross-workspace Reports
          page's read-only, unclickable, top-8 table. */}
      {exceptions.length > 0 && (permissions.viewGuardianHistory || permissions.approveFlags || permissions.grantExceptions) && (
        <div style={{ marginTop: 24 }}>
          <div className="sec-hd" style={{ marginBottom: 10 }}>
            <div className="sec-title">Exceptions granted ({exceptions.length})</div>
          </div>
          {exceptions.map((ex: any) => (
            <ExceptionCard key={ex.id} exception={ex} permissions={permissions} currency={project.currency || 'USD'} />
          ))}
        </div>
      )}
    </div>
  )
}

// FEATURE (deep audit, section 13 — flagship finding): see the "Exceptions
// granted" note above. Read-only card (the record itself — deliverable,
// value, reason, who granted it — is fixed once created; only the
// governance discussion around it, via FlagCollaboration, is interactive).
function ExceptionCard({ exception, permissions, currency }: any) {
  const router = useRouter()
  const canWrite = permissions.approveFlags || permissions.grantExceptions
  // FEATURE (independent pass, section 13): an exception was write-once — a typo in the value or
  // reason permanently skewed Reports and the at-risk rollup. GRANT_EXCEPTIONS holders can now
  // correct it (PATCH /api/guardian/exceptions/[id]); the before/after is kept in the audit log.
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [what, setWhat] = useState<string>(exception.granted_what || '')
  const [reason, setReason] = useState<string>(exception.reason || '')
  const [value, setValue] = useState<string>(String(exception.estimated_value ?? 0))

  async function save() {
    setSaving(true); setError('')
    try {
      const res = await fetch(`/api/guardian/exceptions/${exception.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantedWhat: what, reason, ...(permissions.viewFinancials ? { estimatedValue: value } : {}) }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not save')
      setEditing(false)
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally { setSaving(false) }
  }

  return (
    <div className="surface surface-p" style={{ marginBottom: 10 }}>
      {editing ? (
        <div>
          {error && <p className="ferr" style={{ marginBottom: 6 }}>{error}</p>}
          <div className="fgrp">
            <label className="flbl">What was granted</label>
            <input className="finp" value={what} onChange={e => setWhat(e.target.value)} maxLength={1000} />
          </div>
          <div className="fgrp">
            <label className="flbl">Reason</label>
            <textarea className="finp" rows={2} value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} />
          </div>
          {permissions.viewFinancials && (
            <div className="fgrp">
              <label className="flbl">Estimated value ({currency})</label>
              <input className="finp" inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-xs" onClick={save} disabled={saving || !what.trim() || !reason.trim()}>
              {saving ? <span className="spin" /> : 'Save changes'}
            </button>
            <button className="btn btn-ghost btn-xs" onClick={() => { setEditing(false); setError('') }} disabled={saving}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{exception.granted_what || exception.deliverable || 'Exception'}</div>
            {exception.reason && (
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{exception.reason}</div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
              {formatRelative(exception.created_at)}
              {exception.updated_at ? ` · edited ${formatRelative(exception.updated_at)}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {permissions.viewFinancials && (
              <div style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                {formatCurrency(exception.estimated_value || 0, currency)}
              </div>
            )}
            {permissions.grantExceptions && (
              <button className="btn btn-ghost btn-xs" onClick={() => setEditing(true)}>Edit</button>
            )}
          </div>
        </div>
      )}
      <FlagCollaboration entityType="exception" entityId={exception.id} canWrite={canWrite} />
    </div>
  )
}

// FEATURE (deep audit, section 13 — flagship finding): the missing read
// surface for guardian_checks — see app/api/guardian/checks/route.ts and
// the ACCESS_GUARDIAN_HISTORY note on GuardianTab above. Every check that
// doesn't produce a flag (in_scope, covered_by_co, duplicate, pending, and
// critically classification_failed) was previously visible nowhere in the
// product; this is the only place any of that is now surfaced.
function GuardianHistoryPanel({ projectId, canRetry }: { projectId: string; canRetry: boolean }) {
  const [checks,   setChecks]   = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,    setError]    = useState('')
  const [hasMore,  setHasMore]  = useState(false)
  const [cursor,   setCursor]   = useState<string | null>(null)
  // FEATURE (deep audit, section 13 — feature gap): pairs with the new
  // POST /api/guardian/checks/[id]/retry route — see that file's own
  // comment for why this was missing entirely. retryingId/retryError are
  // scoped to a single check at a time since retrying is a rare,
  // deliberate per-row action, not something done in bulk.
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<{ id: string; message: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    fetch(`/api/guardian/checks?projectId=${projectId}`)
      .then(res => res.json())
      .then(json => {
        if (cancelled) return
        if (json.error) { setError(json.error); return }
        setChecks(json.checks || [])
        setHasMore(!!json.hasMore)
        setCursor(json.nextCursor || null)
      })
      .catch(() => { if (!cancelled) setError('Could not load check history.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  async function loadMore() {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const res  = await fetch(`/api/guardian/checks?projectId=${projectId}&before=${encodeURIComponent(cursor)}`)
      const json = await res.json()
      if (json.error) { setError(json.error); return }
      setChecks(prev => [...prev, ...(json.checks || [])])
      setHasMore(!!json.hasMore)
      setCursor(json.nextCursor || null)
    } finally { setLoadingMore(false) }
  }

  async function retryCheck(checkId: string) {
    setRetryingId(checkId); setRetryError(null)
    try {
      const res  = await fetch(`/api/guardian/checks/${checkId}/retry`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Retry failed')
      // Targeted update rather than a full refetch — a retry only ever
      // changes the one row that was retried, and refetching would also
      // silently discard anything loaded via "Load more" beyond page one.
      setChecks(prev => prev.map(c => c.id === checkId
        ? { ...c, outcome: json.outcome, classificationFailed: false, matchedReference: json.matchedReference, flagId: json.flagId }
        : c))
    } catch (err: unknown) {
      setRetryError({ id: checkId, message: err instanceof Error ? err.message : 'Retry failed' })
    } finally { setRetryingId(null) }
  }

  return (
    <div className="surface surface-p" style={{ marginBottom: 16 }}>
      <div className="sec-hd" style={{ marginBottom: 10 }}>
        <div className="sec-title">Check history</div>
      </div>
      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>Loading…</div>
      ) : error ? (
        <p style={{ fontSize: 12, color: 'var(--red)' }}>{error}</p>
      ) : checks.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-4)', fontStyle: 'italic' }}>No checks recorded yet.</p>
      ) : (
        <>
          {checks.map(c => {
            // FIX (deep audit, section 13, finding #6): guardian_checks.
            // outcome is DB-constrained to pending/in_scope/borderline/
            // out_of_scope/covered_by_co — 'duplicate' and
            // 'classification_failed' live in separate boolean columns
            // (is_duplicate / classification_failed) and both leave
            // outcome='pending' in the row. This panel indexed VERDICT_COPY
            // by the raw c.outcome, so both cases rendered as a plain,
            // wrong "No signed SOW yet" pending verdict — indistinguishable
            // from a genuine pending check, and directly contradicting this
            // panel's own header comment that classification failures are
            // "surfaced" here. The POST /api/guardian/check response
            // already gets this right by returning a synthetic outcome
            // string for these two cases (see lastResult above) — apply
            // the same derivation to the history rows.
            const displayOutcome = c.isDuplicate ? 'duplicate' : c.classificationFailed ? 'classification_failed' : c.queued ? 'queued' : c.outcome
            const v = VERDICT_COPY[displayOutcome] || VERDICT_COPY.pending
            return (
              <div key={c.id} style={{
                display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 0',
                borderBottom: '1px solid var(--surface-2)',
              }}>
                <i className={`ti ${v.icon}`} style={{ fontSize: 14, color: v.color, marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: v.color, fontWeight: 500 }}>{v.title}</span>
                    <span style={{ color: 'var(--text-4)' }}>·</span>
                    <span style={{ color: 'var(--text-3)' }}>
                      {c.source === 'email' ? `Email${c.fromEmail ? ` from ${c.fromEmail}` : ''}` : `Pasted by ${c.submittedByName || 'Unknown'}`}
                    </span>
                    <span style={{ color: 'var(--text-4)' }}>·</span>
                    <span style={{ color: 'var(--text-4)' }}>{formatRelative(c.submittedAt)}</span>
                    {c.isRetroactive && <span className="pill pill-slate pill-sm">Retroactive</span>}
                    {c.source === 'email' && c.senderKnown === false && (
                      <span className="pill pill-amber pill-sm" title="This sender is not the client's email, a CC address or a saved contact">Unrecognised sender</span>
                    )}
                  </div>
                  {c.subject && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>Subject: {c.subject}</div>
                  )}
                  {c.contentPreview && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.4 }}>
                      {c.contentPreview}{c.contentPreview.length >= 240 ? '…' : ''}
                    </div>
                  )}
                  {c.matchedReference && (
                    <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>Matched: {c.matchedReference}</div>
                  )}
                  {Array.isArray(c.attachmentNames) && c.attachmentNames.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>
                      <i className="ti ti-paperclip" style={{ fontSize: 11 }} /> {c.attachmentNames.length} attachment{c.attachmentNames.length !== 1 ? 's' : ''} not analysed: {c.attachmentNames.join(', ')}
                    </div>
                  )}
                  {c.isDuplicate && (
                    <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>Duplicate of an earlier check</div>
                  )}
                  {c.classificationFailed && canRetry && (
                    <div style={{ marginTop: 6 }}>
                      <button className="btn btn-ghost btn-sm" style={{ height: 24, fontSize: 11 }}
                        onClick={() => retryCheck(c.id)} disabled={retryingId === c.id}>
                        {retryingId === c.id ? <span className="spin" /> : <><i className="ti ti-refresh" style={{ fontSize: 11 }} /> Retry classification</>}
                      </button>
                      {retryError && retryError.id === c.id && (
                        <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{retryError.message}</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {hasMore && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <span className="spin" /> : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function FlagCard({ flag, permissions, router, projectId, team }: any) {
  const [acting, setActing] = useState(false)
  // FIX (deep audit, section 13, finding #4): res.ok was never checked —
  // a 409 (already resolved/closed/converted), a 403, or any other error
  // still fell through to router.refresh() as if it had succeeded, with
  // no error shown anywhere. Every other action handler in this file
  // (handlePasteSubmit, EscalateCoModal, CoCard.doAction,
  // ArchiveClientButton) checks res.ok and surfaces json.error — this one
  // didn't.
  const [actionError, setActionError] = useState('')
  const [showException, setShowException] = useState(false)
  const [showEscalate,  setShowEscalate]  = useState(false)
  const [showClose,     setShowClose]     = useState(false)
  const [showSource,    setShowSource]    = useState(false)
  const canSeeSource = permissions.approveFlags || permissions.grantExceptions || permissions.createCo || permissions.viewGuardianHistory

  async function handleAction(action: string, extra: Record<string, unknown> = {}) {
    setActing(true); setActionError('')
    try {
      const res  = await fetch(`/api/guardian/flags/${flag.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, projectId, ...extra }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(json.error || 'Action failed — try again.'); return false }
      // FIX: draft_co creates a real, editable CO — but this just did
      // router.refresh() and left the user on the Guardian tab with no way
      // to find it. Take them straight to the new draft.
      if (action === 'draft_co' && json.coId) {
        router.push(`/projects/${projectId}/co/${json.coId}`)
        return true
      }
      router.refresh()
      return true
    } catch {
      setActionError('Action failed — try again.')
      return false
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
            <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {permissions.createCo && (
                <button className="btn btn-primary btn-xs" onClick={() => handleAction('draft_co')} disabled={acting}>
                  <i className="ti ti-plus" style={{ fontSize: 11 }} /> Draft CO
                </button>
              )}
              {permissions.approveFlags && (
                <button className="btn btn-ghost btn-xs" onClick={() => handleAction('resolve')} disabled={acting}>Resolve</button>
              )}
              {permissions.grantExceptions && (
                <button className="btn btn-ghost btn-xs" onClick={() => setShowException(true)} disabled={acting}>Exception</button>
              )}
              {/* FIX (deep audit, section 13, finding #2): 'escalate' and
                  'close' have been fully built and permission-checked
                  server-side (see guardian/flags/[id]/route.ts) since
                  audit round 2 — this component just never had a button
                  for either, so a flag could never be escalated or closed,
                  only resolved/exception'd/drafted-to-CO. */}
              {permissions.approveFlags && (
                <button className="btn btn-ghost btn-xs" onClick={() => setShowEscalate(true)} disabled={acting}>Escalate</button>
              )}
              {permissions.approveFlags && (
                <button className="btn btn-ghost btn-xs" onClick={() => setShowClose(true)} disabled={acting}>Close</button>
              )}
            </div>
          )}
          {/* FIX (re-audit, Guardian ghost-feature finding): confirm_out_of_
              scope/dismiss_borderline have existed as flag actions since a
              prior fix round, but nothing in this UI ever rendered a button
              for status === 'borderline_review' — every borderline flag
              was a dead end no one could act on. */}
          {flag.status === 'borderline_review' && permissions.approveFlags && (
            <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary btn-xs" onClick={() => handleAction('confirm_out_of_scope')} disabled={acting}>
                Confirm out of scope
              </button>
              <button className="btn btn-ghost btn-xs" onClick={() => handleAction('dismiss_borderline')} disabled={acting}>
                Dismiss
              </button>
              <button className="btn btn-ghost btn-xs" onClick={() => setShowEscalate(true)} disabled={acting}>Escalate</button>
            </div>
          )}
          {/* FIX (deep audit, section 13, finding #2): 'close' is also valid
              from 'resolved' (see the route's own status guard) — a
              resolved flag previously had no action available at all. */}
          {flag.status === 'resolved' && permissions.approveFlags && (
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {/* Reopen: only where nothing downstream depends on the outcome (the API enforces the same
                  rule) — not a flag resolved by an exception or a change order. */}
              {flag.resolution === 'closed' && !flag.change_order_id && (
                <button className="btn btn-ghost btn-xs" onClick={() => handleAction('reopen')} disabled={acting}>Reopen</button>
              )}
              <button className="btn btn-ghost btn-xs" onClick={() => setShowClose(true)} disabled={acting}>Close</button>
            </div>
          )}
          {/* FEATURE (independent pass, section 13): closed / dismissed flags were terminal. */}
          {flag.status === 'closed' && permissions.approveFlags && !flag.change_order_id && (
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button className="btn btn-ghost btn-xs" onClick={() => handleAction('reopen')} disabled={acting}>Reopen</button>
            </div>
          )}
        </div>
        {actionError && <p className="ferr" style={{ marginTop: 4 }}>{actionError}</p>}
        {canSeeSource && (
          <FlagSource flagId={flag.id} open={showSource} onToggle={() => setShowSource(v => !v)} />
        )}
        <FlagCollaboration
          entityType="flag"
          entityId={flag.id}
          canWrite={permissions.approveFlags || permissions.grantExceptions}
        />
      </div>
      {showException && (
        <ExceptionModal
          flag={flag}
          onClose={() => setShowException(false)}
          onSubmit={async (fields: any) => {
            const ok = await handleAction('exception', fields)
            if (ok) setShowException(false)
            return ok
          }}
        />
      )}
      {showEscalate && (
        <EscalateFlagModal
          flag={flag}
          team={team}
          onClose={() => setShowEscalate(false)}
          onSubmit={async (fields: any) => {
            const ok = await handleAction('escalate', fields)
            if (ok) setShowEscalate(false)
            return ok
          }}
        />
      )}
      {showClose && (
        <CloseFlagModal
          onClose={() => setShowClose(false)}
          onSubmit={async (fields: any) => {
            const ok = await handleAction('close', fields)
            if (ok) setShowClose(false)
            return ok
          }}
        />
      )}
    </div>
  )
}

// FEATURE (independent pass, section 13): a flag showed only the model's one-sentence reasoning — the
// client's actual message, who sent it and when were visible only in the separate history panel (and
// only with ACCESS_GUARDIAN_HISTORY). Anyone who can act on a flag can now read the request behind it.
function FlagSource({ flagId, open, onToggle }: { flagId: string; open: boolean; onToggle: () => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [source, setSource] = useState<any>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || state !== 'idle') return
    setState('loading')
    fetch(`/api/guardian/flags/${flagId}`)
      .then(async res => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error || 'Could not load the original request')
        setSource(json.source || null); setState('done')
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : 'Could not load the original request'); setState('error') })
  }, [open, state, flagId])

  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn btn-ghost btn-xs" onClick={onToggle}>
        <i className={`ti ${open ? 'ti-chevron-up' : 'ti-quote'}`} style={{ fontSize: 11 }} /> {open ? 'Hide original request' : 'View original request'}
      </button>
      {open && (
        <div style={{ marginTop: 8, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 12 }}>
          {state === 'loading' && <span style={{ color: 'var(--text-3)' }}>Loading…</span>}
          {state === 'error' && <span style={{ color: 'var(--red)' }}>{error}</span>}
          {state === 'done' && !source && <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>No original request is linked to this flag.</span>}
          {state === 'done' && source && (
            <>
              <div style={{ color: 'var(--text-3)', marginBottom: 6 }}>
                {source.channel === 'email'
                  ? `Email${source.fromEmail ? ` from ${source.fromEmail}` : ''}`
                  : `Pasted by ${source.submittedByName || 'a team member'}`}
                {' · '}{formatRelative(source.submittedAt)}
                {source.isRetroactive ? ' · retroactive' : ''}
                {source.senderKnown === false ? ' · unrecognised sender' : ''}
              </div>
              {source.subject && <div style={{ color: 'var(--text-3)', marginBottom: 4 }}>Subject: {source.subject}</div>}
              <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-1)', lineHeight: 1.5, maxHeight: 260, overflowY: 'auto' }}>{source.content}</div>
              {source.attachmentNames?.length > 0 && (
                <div style={{ color: 'var(--text-4)', marginTop: 6 }}>
                  <i className="ti ti-paperclip" style={{ fontSize: 11 }} /> Attachments (not analysed): {source.attachmentNames.join(', ')}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// FIX (deep audit, section 13, finding #1): the missing collection surface
// for exceptions_log.estimated_value/reason — see guardian/flags/[id]
// 'exception' case for the backend half of this fix. Every exception
// granted before now recorded $0 and an empty reason because nothing ever
// asked for either.
function ExceptionModal({ flag, onClose, onSubmit }: any) {
  const [grantedWhat, setGrantedWhat] = useState(flag.description || '')
  const [estimatedValue, setEstimatedValue] = useState('')
  const [exceptionReason, setExceptionReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!exceptionReason.trim()) { setError('A reason is required.'); return }
    setBusy(true); setError('')
    try {
      const ok = await onSubmit({ grantedWhat: grantedWhat.trim(), estimatedValue, exceptionReason: exceptionReason.trim() })
      if (!ok) setError('Could not save the exception — try again.')
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Grant exception</h2>
        <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
          Record what&rsquo;s being given away for free and why — this is the audit trail for scope granted without a change order.
        </p>
        <label className="form-label">What&rsquo;s being granted</label>
        <textarea className="form-input" rows={2} value={grantedWhat} onChange={(e) => setGrantedWhat(e.target.value)}
          style={{ marginBottom: 12 }} />
        <label className="form-label">Estimated value <span className="fhint">— optional, defaults to $0</span></label>
        <input type="number" min="0" step="0.01" className="form-input" value={estimatedValue}
          onChange={(e) => setEstimatedValue(e.target.value)} placeholder="0.00" style={{ marginBottom: 12 }} />
        <label className="form-label">Reason</label>
        <textarea className="form-input" rows={3} value={exceptionReason} onChange={(e) => setExceptionReason(e.target.value)}
          placeholder="e.g. Client relationship — one-time goodwill, not worth a CO for $200…" />
        {error && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy || !exceptionReason.trim()}>
            {busy ? <span className="spin" /> : 'Grant exception'}
          </button>
        </div>
      </div>
    </div>
  )
}

// FIX (deep audit, section 13, finding #2): mirrors EscalateCoModal — the
// backend action this posts to has existed and been permission-audited
// since audit round 2, but had no UI entry point until now.
function EscalateFlagModal({ flag, team, onClose, onSubmit }: any) {
  const [escalateTo, setEscalateTo] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (note.trim().length < 10) { setError('Note must be at least 10 characters.'); return }
    setBusy(true); setError('')
    try {
      const ok = await onSubmit({ escalateTo: escalateTo || null, escalationNote: note.trim() })
      if (!ok) setError('Could not escalate — try again.')
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Escalate scope flag</h2>
        <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
          Flag &ldquo;{flag.sow_reference}&rdquo; for someone to step in. This doesn&rsquo;t change its status — it&rsquo;s just a heads-up.
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
          placeholder="e.g. Client is pushing back hard on this being out of scope…" />
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

// FIX (deep audit, section 13, finding #2): 'close' — same missing UI
// entry point as escalate. Reason is optional server-side (close_reason
// can be null), so this modal allows submitting blank.
function CloseFlagModal({ onClose, onSubmit }: any) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setBusy(true); setError('')
    try {
      const ok = await onSubmit({ reason: reason.trim() || undefined })
      if (!ok) setError('Could not close — try again.')
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Close flag</h2>
        <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
          Closes this flag without resolving it or drafting a change order.
        </p>
        <label className="form-label">Reason <span className="fhint">— optional</span></label>
        <textarea className="form-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Superseded by a broader CO covering this and other items…" />
        {error && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
            {busy ? <span className="spin" /> : 'Close flag'}
          </button>
        </div>
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
        {permissions.createCo && ['Active', 'Stalled'].includes(project.status) && (
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
          // FIX (section-11 audit, flagship finding): pendingApprovals is
          // keyed by `${document_type}:${document_id}` (see
          // app/(app)/projects/[id]/page.tsx), and a CO's negotiated-
          // counter approval is filed under document_type 'co_counter' —
          // a DIFFERENT key from the CO's own 'co:<id>' send-approval.
          // Only checking 'co:' meant a CO sitting in 'countered' status
          // with a pending co_counter approval showed no "Awaiting
          // approval" badge at all, and CoCard's "Accept counter" button
          // (below) stayed fully live with no indication anything was
          // already in flight. The two keys are never populated at the
          // same time for one CO (only one document_type can be pending
          // per document at once), so checking both is safe.
          <CoCard key={co.id} co={co} currency={currency} permissions={permissions} projectId={project.id}
            pendingApproval={pendingApprovals?.[`co:${co.id}`] || pendingApprovals?.[`co_counter:${co.id}`]} team={team} />
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
  const [actionNotice, setActionNotice] = useState('')
  // FIX (fix round, section-11 flagship finding): same gap as the SOW
  // tab's matching fix — a CO or CO-counter approval that fully cleared
  // but failed to auto-send had no retry path anywhere on this card.
  const [retrying, setRetrying] = useState(false)
  async function retrySend(approvalRequestId: string) {
    setRetrying(true); setActionError('')
    try {
      const res  = await fetch(`/api/approvals/${approvalRequestId}/retry-send`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(json?.error || 'Retry failed'); return }
      if (json?.deliveryWarning) alert(json.deliveryWarning)
      router.refresh()
    } catch {
      setActionError('Retry failed')
    } finally { setRetrying(false) }
  }
  // Release an approved-but-unsent request so the document is editable again (section-11 audit, pass 2).
  async function cancelApproval(approvalRequestId: string) {
    if (!confirm('Cancel this approved request? The document goes back to being an editable draft, and sending it again will need a fresh approval.')) return
    setRetrying(true); setActionError('')
    try {
      const res  = await fetch(`/api/approvals/${approvalRequestId}/cancel`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(json?.error || 'Could not cancel the request'); return }
      window.dispatchEvent(new Event('scopegov:approvals-changed'))
      router.refresh()
    } catch {
      setActionError('Could not cancel the request')
    } finally { setRetrying(false) }
  }
  async function doAction(action: string) {
    setActing(true); setActionError(''); setActionNotice('')
    try {
      const res  = await fetch(`/api/co/${co.id}/${action}`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(json?.error || 'That action failed. Please try again.'); return }
      if (json?.pendingApproval) {
        alert(action === 'accept-counter'
          ? 'Sent for approval — the client will be asked to countersign the negotiated amount once it\u2019s signed off.'
          : 'Sent for approval — this CO will go to the client automatically once it\u2019s signed off.')
      }
      // The mail provider can reject a message without the request failing — say so rather than imply
      // the client has been told.
      if (json?.emailSent === false)
        setActionNotice(`Done, but the email to the client could not be delivered (${json.emailError || 'provider error'}). Use "Copy link" and send it to them yourself.`)
      else if (json?.clientNotified === false)
        setActionNotice('Done, but the notification email to the client could not be delivered — you may want to let them know directly.')
      router.refresh()
    } catch {
      setActionError('That action failed. Please try again.')
    } finally { setActing(false) }
  }

  async function copyLink() {
    setActionError(''); setActionNotice('')
    try {
      const res  = await fetch(`/api/co/${co.id}/link`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(json?.error || 'Could not get the response link.'); return }
      try { await navigator.clipboard.writeText(json.portalUrl); setActionNotice('Response link copied to your clipboard.') }
      catch { window.prompt('Copy this response link:', json.portalUrl) }
    } catch { setActionError('Could not get the response link.') }
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
            {pendingApproval && pendingApproval.sendFailed && (
              <span className="pill pill-red" title={pendingApproval.sendFailedReason || undefined}>
                <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} /> Approved — not sent
              </span>
            )}
            {pendingApproval && !pendingApproval.sendFailed && (
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
          {co.status === 'draft' && pendingApproval && pendingApproval.sendFailed && permissions.sendCo && (
            <>
              <button className="btn btn-ghost btn-xs" onClick={() => cancelApproval(pendingApproval.id)} disabled={retrying}>Cancel request</button>
              <button className="btn btn-primary btn-xs" onClick={() => retrySend(pendingApproval.id)} disabled={retrying}>
                {retrying ? <span className="spin" /> : 'Retry send'}
              </button>
            </>
          )}
          {co.status === 'draft' && pendingApproval && !pendingApproval.sendFailed && (
            <Link href={`/approvals?highlight=${pendingApproval.id}`}><button className="btn btn-ghost btn-xs">Awaiting approval</button></Link>
          )}
          {/* 'stalled' is a live, sent CO (no reply for 5 days) and could previously only be Closed. */}
          {(co.status === 'awaiting_response' || co.status === 'stalled') && (
            <button className="btn btn-ghost btn-xs" onClick={() => doAction('withdraw')} disabled={acting}>Withdraw</button>
          )}
          {['awaiting_response', 'stalled', 'awaiting_countersignature'].includes(co.status) && permissions.sendCo && (
            <button className="btn btn-ghost btn-xs" onClick={copyLink} disabled={acting} title="Copy the client's response link">
              <i className="ti ti-link" style={{ fontSize: 12 }} /> Copy link
            </button>
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
              CO into a fresh editable draft instead.
              FIX (section-10 audit, feature gap — CO expiry): 'expired'
              added — same recovery path as declined/withdrawn/closed. */}
          {['declined', 'withdrawn', 'closed', 'expired'].includes(co.status) && permissions.createCo && (
            <button className="btn btn-ghost btn-xs" onClick={revise} disabled={acting}>
              Revise &amp; resend
            </button>
          )}
          {/* FIX (section-11 audit, flagship finding): this button used to
              render regardless of pendingApproval, so a countered CO whose
              negotiated amount had already tripped an approval workflow
              still showed a fully-live "Accept counter" button with zero
              indication a decision was already in flight — clicking it
              again just silently re-confirmed the existing pending
              request. Mirrors the co.status === 'draft' pattern above:
              swap to a disabled "Awaiting approval" link once pending. */}
          {co.status === 'countered' && permissions.sendCo && !pendingApproval && (
            <button className="btn btn-primary btn-xs" onClick={() => doAction('accept-counter')} disabled={acting}>Accept counter</button>
          )}
          {co.status === 'countered' && pendingApproval && (
            <Link href="/approvals"><button className="btn btn-ghost btn-xs">Awaiting approval</button></Link>
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
          {/* FIX (section-10 audit, feature gap — CO expiry): 'expired'
              added — same as 'declined'/'stalled', an agency should be
              able to close out a dead CO instead of only being able to
              revise it.
              FIX (fix round, CO-G2): 'draft' added — the close route's own
              TERMINAL_FROM list has always allowed closing a plain draft
              ("'draft' never had a client-facing state, so nothing to
              notify there"), and already cancels any pending approval
              request on the way. Nothing in the UI ever exposed it: a
              draft CO created by mistake, or simply abandoned, had no way
              to be discarded — Cancel in the editor just navigates away
              without touching the row, and there's no delete endpoint. */}
          {['countered','stalled','declined','expired','draft'].includes(co.status) && (
            <button className="btn btn-ghost btn-xs" onClick={() => doAction('close')} disabled={acting}>Close</button>
          )}
          {/* FIX (section-10 audit, feature gap — CO expiry): 'expired'
              excluded — there's nothing left to escalate on a dead,
              already-terminal link; escalation is for an open
              negotiation, same reasoning the escalate route's own status
              guard already applies. */}
          {permissions.sendCo && !['closed', 'accepted', 'withdrawn', 'expired'].includes(co.status) && (
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
      {actionNotice && !actionError && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-2)', borderLeft: '3px solid var(--amber)', paddingLeft: 10 }}>{actionNotice}</div>
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
// Rows arrive pre-shaped from lib/utils/activity-format.ts (a sentence + optional detail line; no raw
// audit metadata ever reaches the browser). Older history pages in through /api/projects/[id]/activity —
// the tab used to stop dead at the newest 50 events.
const TONE_COLOUR: Record<string, string> = {
  green: 'var(--green)', red: 'var(--red)', amber: 'var(--amber)', blue: 'var(--blue)',
}

function ActivityTab({ projectId, initial, initialHasMore }: { projectId: string; initial: ShapedActivity[]; initialHasMore: boolean }) {
  const [rows, setRows]       = useState<ShapedActivity[]>(initial)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')

  // A router.refresh() hands down a fresh first page; keep it authoritative.
  useEffect(() => { setRows(initial); setHasMore(initialHasMore) }, [initial, initialHasMore])

  async function loadMore() {
    setLoading(true); setLoadError('')
    try {
      const res  = await fetch(`/api/projects/${projectId}/activity?offset=${rows.length}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not load more activity')
      const seen = new Set(rows.map(r => r.id))
      setRows([...rows, ...(json.rows || []).filter((r: ShapedActivity) => !seen.has(r.id))])
      setHasMore(!!json.hasMore)
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Could not load more activity')
    } finally { setLoading(false) }
  }

  return (
    <div>
      {rows.length === 0 ? (
        <div className="surface">
          <div className="empty-state" style={{ padding: '32px 24px' }}>
            <i className="ti ti-clock empty-state-icon" />
            <p className="empty-state-title">No activity yet</p>
          </div>
        </div>
      ) : (
        <div className="surface surface-p">
          {rows.map(a => (
            <div key={a.id} className="feed-item">
              <div className="feed-dot" style={{ background: TONE_COLOUR[a.tone] || 'var(--blue)', marginTop: 6 }} />
              <div className="feed-body">
                <div className="feed-text">
                  {a.actor && <><strong>{a.actor}</strong>{' '}</>}{a.text}
                </div>
                {a.detail && (
                  <div className="feed-text" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{a.detail}</div>
                )}
                <div className="feed-time">{formatRelative(a.created_at)}</div>
              </div>
            </div>
          ))}
          {(hasMore || loadError) && (
            <div style={{ padding: '12px 0 4px', textAlign: 'center' }}>
              {loadError && <div style={{ fontSize: 12.5, color: 'var(--red)', marginBottom: 8 }}>{loadError}</div>}
              <button className="btn btn-ghost btn-sm" onClick={loadMore} disabled={loading}>
                {loading ? 'Loading…' : 'Load older activity'}
              </button>
            </div>
          )}
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
  const [removeError, setRemoveError] = useState('')

  // FIX (fix round, Projects & Dashboard section 7): a failed removal (e.g.
  // a permission race or a network error — the API has no last-member guard) used to fail
  // completely silently — the spinner just stopped with no indication
  // anything went wrong, unlike addMember which already surfaces its errors.
  async function removeMember(memberId: string, name: string) {
    if (!confirm(`Remove ${name} from this project?`)) return
    setRemovingId(memberId); setRemoveError('')
    try {
      const res = await fetch(`/api/projects/${project.id}/members`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId }),
      })
      if (res.ok) { router.refresh(); return }
      const json = await res.json().catch(() => ({}))
      setRemoveError(json.error || 'Could not remove that member — try again.')
    } catch {
      setRemoveError('Could not remove that member — try again.')
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

      {removeError && <p className="ferr" style={{ marginBottom: 10 }}>{removeError}</p>}

      {team.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No members assigned to this project yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {team.map((t: any) => {
            const u = t.workspace_members?.users
            return u ? (
              <div key={t.id} className="surface surface-p" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {/* FIX (deep audit, Workspace lifecycle + Onboarding
                    re-pass — feature gap): u.avatar_url was already
                    selected all the way from page.tsx's query but never
                    rendered here — see
                    api/workspace/profile/avatar/route.ts for where it now
                    comes from. */}
                {u.avatar_url ? (
                  <img src={u.avatar_url} alt="" width={32} height={32}
                    style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                ) : (
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFF', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
                    {u.name?.split(' ').map((p: string) => p[0]).join('').toUpperCase().slice(0, 2)}
                  </div>
                )}
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
