// components/approvals/ApprovalsClient.tsx
'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { SessionUser } from '@/lib/supabase/types'
import { formatCurrencyExact, formatRelative } from '@/lib/utils/format'

interface Step {
  id: string
  step_order: number
  status: 'pending' | 'approved' | 'rejected' | 'skipped'
  note: string | null
  decided_at: string | null
  approver_role_id: string | null
  approver_user_id: string | null
  roles: { id: string; name: string } | null
  approver: { id: string; name: string } | null
  decider: { id: string; name: string } | null
}

interface ApprovalRequest {
  id: string
  // Runtime values include 'co_counter' (accepting a negotiated counter-offer)
  // and 'invoice'.
  document_type: 'sow' | 'co' | 'co_counter' | 'invoice'
  document_id: string
  project_id: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  current_step: number
  total_steps: number
  // amount is null for a viewer without VIEW_FINANCIALS who isn't the approver/requester.
  context: { title?: string; amount?: number | null; currency?: string; project_name?: string }
  created_at: string
  decided_at: string | null
  requested_by: string
  // Set when the auto-send that fires on final approval fails (migration 053).
  send_failed_at: string | null
  send_failed_reason: string | null
  // The document WAS sent but the client email was rejected (migration 069).
  delivery_warning: string | null
  // Set while the auto-send after the final approval is running (migration 069).
  sending_started_at: string | null
  allow_self_approval: boolean
  require_distinct_approvers: boolean
  reminder_count: number
  // Computed by the server for THIS viewer: assigned to the current step, holds
  // the approve permission, and isn't blocked by the requester / distinct-approver rules.
  canDecide: boolean
  requester: { id: string; name: string; email: string } | null
  projects: { id: string; name: string } | null
  approval_steps: Step[]
}

type Tab = 'mine' | 'submitted' | 'all'

function documentLabelFor(documentType: ApprovalRequest['document_type']): string {
  if (documentType === 'sow') return 'SOW'
  if (documentType === 'invoice') return 'Invoice'
  if (documentType === 'co_counter') return 'Change order counter-offer'
  return 'Change order'
}

function shortTypeLabel(documentType: ApprovalRequest['document_type']): string {
  return documentType === 'sow' ? 'SOW' : documentType === 'invoice' ? 'Invoice' : documentType === 'co_counter' ? 'CO counter' : 'CO'
}

// FIX (section-11/12 fix round): this confirm text used to claim, unconditionally,
// that cancelling returns the document to an editable draft. True for sow/co/invoice
// (they genuinely stay status:'draft' the whole time their gate is pending) — but a
// co_counter gate (accepting a client's counter-offer) leaves the underlying CO at
// status:'countered' the whole time (see accept-co-counter.ts), never draft.
// Cancelling one of those doesn't make anything editable again — the CO just stays
// 'countered', still awaiting the agency's decision on the counter. Matches the same
// document_type branch now applied server-side in POST /api/approvals/[id]/cancel.
//
// FIX (re-audit, section-11 finding): `sendFailed` now shapes the opening clause too.
// This used to always say "Cancel this approved request?" — accurate for the
// approved-but-unsent case, but wrong (and the reason the modal's own cancel button
// skipped confirm() entirely for a still-pending chain — see that call site) when
// nothing has been approved yet. A still-pending, possibly multi-step chain with
// earlier steps already signed off is exactly the case a confirmation exists to catch.
function cancelConfirmMessage(documentType: ApprovalRequest['document_type'], sendFailed: boolean): string {
  const subject = sendFailed ? 'this approved request' : 'this pending approval request'
  return documentType === 'co_counter'
    ? `Cancel ${subject}? The change order stays as-is, still awaiting a decision on the counter-offer — accepting it again will need a fresh approval.`
    : `Cancel ${subject}? The document goes back to being an editable draft, and sending it again will need a fresh approval.`
}

// Which project tab shows the document being decided, so an approver can open
// it before deciding. canReadProject already gates who may decide, so anyone
// eligible is entitled to that tab.
function tabForDocumentType(documentType: ApprovalRequest['document_type']): string {
  if (documentType === 'sow') return 'sow'
  if (documentType === 'invoice') return 'billing'
  return 'co' // 'co' and 'co_counter' both live on the CO tab
}

// A send-failed request (status='approved', send_failed_at set) must not read
// as a plain "Approved" — it never reached the client.
function isSending(r: Pick<ApprovalRequest, 'status' | 'sending_started_at'>): boolean {
  return r.status === 'pending' && !!r.sending_started_at
}
function requestPill(r: ApprovalRequest): string {
  if (r.status === 'approved' && r.send_failed_at) return 'red'
  if (r.status === 'approved' && r.delivery_warning) return 'amber'
  if (isSending(r)) return 'amber'
  const m: Record<string, string> = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: 'slate' }
  return m[r.status] || 'slate'
}
function requestLabel(r: ApprovalRequest): string {
  if (r.status === 'approved' && r.send_failed_at) return 'Approved — not sent'
  if (r.status === 'approved' && r.delivery_warning) return 'Sent — email bounced'
  if (isSending(r)) return 'Sending…'
  const m: Record<string, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' }
  return m[r.status] || r.status
}

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
]
const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All documents' },
  { value: 'sow', label: 'SOWs' },
  { value: 'co', label: 'Change orders' },
  { value: 'co_counter', label: 'CO counter-offers' },
  { value: 'invoice', label: 'Invoices' },
]

export default function ApprovalsClient({ session, canViewAll, canManageWorkflows, canApprove }: {
  session: SessionUser; canViewAll: boolean; canManageWorkflows: boolean; canApprove: boolean
}) {
  const searchParams = useSearchParams()
  const highlight = searchParams.get('highlight')

  // FIX (section-11 audit, pass 2): a requester without approve/oversight
  // permissions had no way to see, track or cancel their own pending request —
  // the "submitted" list only ever fed the send-failed banner. Everyone now gets
  // a "My requests" tab.
  const tabs: Array<{ id: Tab; label: string }> = []
  if (canApprove || canViewAll) tabs.push({ id: 'mine', label: 'My queue' })
  tabs.push({ id: 'submitted', label: 'My requests' })
  if (canViewAll) tabs.push({ id: 'all', label: 'All requests' })

  const [tab, setTab] = useState<Tab>(canApprove || canViewAll ? 'mine' : 'submitted')
  const [items, setItems] = useState<ApprovalRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<ApprovalRequest | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  // Requests the caller submitted that were approved but not sent — fetched
  // independently of the tabs, since they belong to the ORIGINAL REQUESTER who
  // may hold neither the approving role nor oversight permissions.
  const [needsRetry, setNeedsRetry] = useState<ApprovalRequest[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  // The "My queue" count fetched independently so it stays live on any tab
  // (same number the Sidebar badge shows).
  const [mineCount, setMineCount] = useState<number | null>(null)

  const loadMineCount = useCallback(async () => {
    try {
      const res  = await fetch('/api/approvals?scope=mine')
      const json = await res.json()
      if (!res.ok) return
      setMineCount((json.requests || []).length)
    } catch { /* non-fatal — the button just shows no count */ }
  }, [])

  const load = useCallback(async (scope: Tab) => {
    setLoading(true); setError('')
    try {
      const res  = await fetch(`/api/approvals?scope=${scope}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to load approvals')
      setItems(json.requests || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals')
    } finally { setLoading(false) }
  }, [])

  const loadNeedsRetry = useCallback(async () => {
    try {
      const res  = await fetch('/api/approvals?scope=submitted')
      const json = await res.json()
      if (!res.ok) return
      setNeedsRetry((json.requests || []).filter((r: ApprovalRequest) => r.status === 'approved' && !!r.send_failed_at))
    } catch { /* non-fatal — the notification is still the primary signal */ }
  }, [])

  useEffect(() => { load(tab) }, [tab, load])
  useEffect(() => { loadNeedsRetry() }, [loadNeedsRetry])
  useEffect(() => { if (canApprove || canViewAll) loadMineCount() }, [canApprove, canViewAll, loadMineCount])

  async function post(id: string, action: 'retry-send' | 'cancel') {
    setBusyId(id); setError('')
    try {
      const res  = await fetch(`/api/approvals/${id}/${action}`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || (action === 'retry-send' ? 'Retry failed' : 'Could not cancel'))
      await Promise.all([load(tab), loadNeedsRetry(), loadMineCount()])
      window.dispatchEvent(new Event('scopegov:approvals-changed'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setBusyId(null) }
  }

  // Auto-open the request linked from a notification or a project tab — ONCE.
  // FIX (section-11 audit, pass 2): this effect re-ran whenever the item list
  // changed and re-selected the highlighted request every time, so after an
  // action (or after switching to the "All requests" tab) the modal for the
  // request you had just decided popped straight back open. openedHighlight
  // makes the auto-open a one-shot.
  const openedHighlight = useRef<string | null>(null)
  const searchedHighlight = useRef<string | null>(null)
  useEffect(() => {
    if (!highlight || loading) return
    if (openedHighlight.current === highlight) return
    const local = items.find(r => r.id === highlight) || needsRetry.find(r => r.id === highlight)
    if (local) { openedHighlight.current = highlight; setSelected(local); return }
    if (searchedHighlight.current === highlight) return
    searchedHighlight.current = highlight
    ;(async () => {
      for (const scope of (canViewAll ? ['submitted', 'all'] : ['submitted'])) {
        try {
          const res  = await fetch(`/api/approvals?scope=${scope}`)
          const json = await res.json()
          if (!res.ok) continue
          const found = (json.requests || []).find((r: ApprovalRequest) => r.id === highlight)
          if (found) { openedHighlight.current = highlight; setSelected(found); return }
        } catch { /* try the next scope */ }
      }
    })()
  }, [highlight, items, needsRetry, loading, canViewAll])

  async function refreshAfterAction() {
    setSelected(null)
    await Promise.all([load(tab), loadNeedsRetry(), loadMineCount()])
    // Sidebar's pending-count badge refetches on this plain DOM event (approving
    // from this page doesn't navigate anywhere).
    window.dispatchEvent(new Event('scopegov:approvals-changed'))
  }

  const visible = tab === 'mine'
    ? items
    : items.filter(r =>
        (!statusFilter || r.status === statusFilter) &&
        (!typeFilter || r.document_type === typeFilter)
      )

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-sub">Sign-offs required before a SOW, change order or invoice reaches the client</p>
        </div>
        {canManageWorkflows && (
          <Link href="/settings/approvals">
            <button className="btn btn-ghost btn-sm"><i className="ti ti-settings" style={{ fontSize: 12 }} /> Configure workflows</button>
          </Link>
        )}
      </div>

      {needsRetry.length > 0 && (
        <div className="surface surface-p" style={{ marginBottom: 18, borderColor: 'var(--red)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', marginBottom: 10 }}>
            <i className="ti ti-alert-triangle" style={{ fontSize: 12 }} /> Needs your attention — approved but not sent
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {needsRetry.map(r => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{r.context?.title || documentLabelFor(r.document_type)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                    {r.projects?.name || r.context?.project_name} · {r.send_failed_reason}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {/* FIX (section-11 audit, pass 2): a send-failed request could be retried
                      but never abandoned — and the document stayed edit-locked meanwhile. */}
                  <button className="btn btn-ghost btn-sm" onClick={() => {
                    if (confirm(cancelConfirmMessage(r.document_type, true))) post(r.id, 'cancel')
                  }} disabled={busyId === r.id}>
                    Cancel request
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => post(r.id, 'retry-send')} disabled={busyId === r.id}>
                    {busyId === r.id ? <span className="spin" /> : 'Retry send'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tabs.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
          {tabs.map(t => (
            <button key={t.id} className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(t.id)}>
              {t.label}{t.id === 'mine' && mineCount ? ` (${mineCount})` : ''}
            </button>
          ))}
        </div>
      )}

      {tab !== 'mine' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <select className="finp" style={{ width: 'auto' }} value={statusFilter}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setStatusFilter(e.target.value)}>
            {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className="finp" style={{ width: 'auto' }} value={typeFilter}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTypeFilter(e.target.value)}>
            {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}

      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

      {loading ? (
        <div className="surface"><div className="empty-state"><span className="spin spin-dark" /></div></div>
      ) : visible.length === 0 ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-shield-check empty-state-icon" />
            <p className="empty-state-title">
              {tab === 'mine' ? 'Nothing waiting on you'
                : items.length > 0 ? 'No requests match these filters'
                : tab === 'submitted' ? 'You haven\u2019t sent anything for approval' : 'No approval requests yet'}
            </p>
            <p className="empty-state-sub">
              {tab === 'mine'
                ? 'Documents gated by an approval workflow will show up here when it\u2019s your turn to decide.'
                : tab === 'submitted'
                ? 'When a SOW, change order or invoice you send needs sign-off, you can follow (and cancel) it here.'
                : 'Once a workflow is configured, SOWs, change orders and invoices that trip it will appear here.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="surface" style={{ overflow: 'hidden' }}>
          <table className="gov-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Project</th>
                <th>Requested by</th>
                <th>Step</th>
                <th>Amount</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={r.id} onClick={() => setSelected(r)}>
                  <td>
                    <span style={{ fontWeight: 500 }}>{r.context?.title || documentLabelFor(r.document_type)}</span>
                    <span className="pill pill-slate pill-sm" style={{ marginLeft: 8 }}>{shortTypeLabel(r.document_type)}</span>
                  </td>
                  <td>{r.projects?.name || r.context?.project_name || '—'}</td>
                  <td>{r.requester?.name || '—'}</td>
                  <td style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12 }}>{r.current_step} / {r.total_steps}</td>
                  <td style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                    {r.context?.amount != null ? formatCurrencyExact(r.context.amount, r.context.currency || 'USD') : '—'}
                  </td>
                  <td><span className={`pill pill-${requestPill(r)}`}>{requestLabel(r)}</span></td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatRelative(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ApprovalDetailModal
          request={selected}
          session={session}
          canManageWorkflows={canManageWorkflows}
          onClose={() => setSelected(null)}
          onDone={refreshAfterAction}
        />
      )}
    </div>
  )
}

function ApprovalDetailModal({ request, session, canManageWorkflows, onClose, onDone }: {
  request: ApprovalRequest
  session: SessionUser
  canManageWorkflows: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [acting, setActing]   = useState<'approve' | 'reject' | 'cancel' | 'retry-send' | 'reassign' | null>(null)
  const [note, setNote]       = useState('')
  const [showReject, setShowReject] = useState(false)
  const [error, setError]     = useState('')
  const [showReassign, setShowReassign] = useState(false)
  const [candidates, setCandidates] = useState<{ users: Array<{ id: string; name: string; email: string }>; roles: Array<{ id: string; name: string }> } | null>(null)
  const [assignee, setAssignee] = useState('')
  const [reassignReason, setReassignReason] = useState('')

  const isRequester = request.requested_by === session.id
  const documentLabel = documentLabelFor(request.document_type)
  const sending = isSending(request)
  const sendFailed = request.status === 'approved' && !!request.send_failed_at
  // The requester or a workspace admin can cancel a pending request — and, now,
  // abandon an approved-but-unsent one (the cancel route accepts it).
  const canCancel = (isRequester || canManageWorkflows) && ((request.status === 'pending' && !sending) || sendFailed)
  const canRetrySend = (isRequester || canManageWorkflows) && sendFailed
  // The server computes this for the viewer (assigned to the current step, holds
  // the approve permission, not blocked by the requester/distinct rules).
  const canDecide = request.canDecide
  const canReassign = canManageWorkflows && request.status === 'pending' && !sending
  const currentStep = request.approval_steps.find(s => s.step_order === request.current_step)

  async function act(action: 'approve' | 'reject' | 'cancel' | 'retry-send', body?: Record<string, unknown>) {
    setActing(action); setError('')
    try {
      const res  = await fetch(`/api/approvals/${request.id}/${action}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `Failed to ${action}`)
      // Approved and sent, but the client email bounced — say so before closing.
      if (action === 'approve' && json.deliveryWarning) alert(json.deliveryWarning)
      if (action === 'retry-send' && json.deliveryWarning) alert(json.deliveryWarning)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`)
    } finally { setActing(null) }
  }

  async function openReassign() {
    setShowReassign(true); setError('')
    if (candidates) return
    try {
      const res  = await fetch(`/api/approvals/${request.id}/approvers`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not load approvers')
      setCandidates({ users: json.users || [], roles: json.roles || [] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load approvers')
    }
  }

  async function submitReassign() {
    if (!assignee) return
    setActing('reassign'); setError('')
    try {
      const [kind, id] = assignee.split(':')
      const res  = await fetch(`/api/approvals/${request.id}/reassign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [kind === 'role' ? 'roleId' : 'userId']: id, reason: reassignReason }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not reassign this step')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reassign this step')
    } finally { setActing(null) }
  }

  return (
    <>
      <div className="modal-bg" onClick={onClose} />
      <div className="modal modal-lg">
        <h2 className="modal-title">{request.context?.title || documentLabel}</h2>
        <p className="modal-sub">
          {documentLabel} on {request.projects?.name || request.context?.project_name} · requested by {request.requester?.name}
          {request.context?.amount != null && <> · {formatCurrencyExact(request.context.amount, request.context.currency || 'USD')}</>}
        </p>
        {request.projects?.id && (
          <p className="modal-sub" style={{ marginTop: -8, marginBottom: 14 }}>
            <Link href={`/projects/${request.projects.id}?tab=${tabForDocumentType(request.document_type)}`} target="_blank" rel="noreferrer">
              <i className="ti ti-external-link" style={{ fontSize: 11 }} /> Open the {documentLabel.toLowerCase()} to review before deciding
            </Link>
          </p>
        )}

        {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

        {sendFailed && (
          <div className="auth-error" style={{ marginBottom: 14 }}>
            <strong>Approved, but couldn&apos;t be sent.</strong> {request.send_failed_reason || 'The send failed.'}
            <div style={{ marginTop: 6, fontSize: 12 }}>
              Retry once the problem is fixed — no re-approval is needed. Or cancel this request{request.document_type === 'co_counter'
                ? ' — the change order stays as-is, still awaiting a decision on the counter-offer (accepting it again will need a new approval).'
                : ' to make the document editable again (sending it afterwards will need a new approval).'}
            </div>
          </div>
        )}
        {request.status === 'approved' && !request.send_failed_at && request.delivery_warning && (
          <div className="auth-error" style={{ marginBottom: 14, borderColor: 'var(--amber)', color: 'var(--text)' }}>
            <strong>Sent — but the client email didn&apos;t go out.</strong> {request.delivery_warning}
          </div>
        )}
        {sending && (
          <div className="surface-p" style={{ marginBottom: 14, fontSize: 12.5, color: 'var(--text-2)' }}>
            Fully approved — the {documentLabel.toLowerCase()} is being sent to the client now. Refresh in a moment.
          </div>
        )}
        {(request.allow_self_approval || request.require_distinct_approvers) && request.status === 'pending' && (
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>
            {request.require_distinct_approvers && 'Each step must be approved by a different person. '}
            {request.allow_self_approval && 'The person who requested this may approve it.'}
          </p>
        )}

        <div style={{ marginBottom: 18 }}>
          {request.approval_steps
            .slice()
            .sort((a, b) => a.step_order - b.step_order)
            .map(step => {
              // FIX (section-11 re-audit — feature gap): every undecided step is
              // inserted as status:'pending' up front (not just the one actually
              // being waited on — see evaluateApprovalGate), so the step actually
              // blocking right now and steps nobody's gotten to yet rendered
              // identically: same amber dot, same "Awaiting decision" text. A
              // rejection skips every other pending step in one shot (migration
              // 069's decide_approval_step), so status:'pending' only ever
              // coexists with request.status:'pending' — meaning the CURRENT
              // step is always exactly the one whose step_order matches
              // request.current_step; anything else still 'pending' genuinely
              // hasn't been reached (and hasn't been notified) yet.
              const isCurrent = step.status === 'pending' && step.step_order === request.current_step
              const notYetReached = step.status === 'pending' && !isCurrent
              return (
              <div key={step.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0',
                borderBottom: '1px solid var(--surface-2)',
              }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 600,
                  background: step.status === 'approved' ? 'var(--green-lt)'
                    : step.status === 'rejected' ? 'var(--red-lt)'
                    : step.status === 'skipped' || notYetReached ? 'var(--surface-2)' : 'var(--amber-lt)',
                  color: step.status === 'approved' ? 'var(--green)'
                    : step.status === 'rejected' ? 'var(--red)'
                    : step.status === 'skipped' || notYetReached ? 'var(--text-4)' : 'var(--amber)',
                }}>
                  {step.status === 'approved' ? <i className="ti ti-check" /> :
                   step.status === 'rejected' ? <i className="ti ti-x" /> : step.step_order}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    {step.roles?.name || step.approver?.name || 'Unassigned'}
                    {step.roles?.name && <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> (any {step.roles.name})</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {isCurrent && 'Awaiting decision'}
                    {notYetReached && 'Not yet reached'}
                    {step.status === 'skipped' && 'Skipped — request closed'}
                    {(step.status === 'approved' || step.status === 'rejected') && (
                      <>{step.status === 'approved' ? 'Approved' : 'Rejected'} by {step.decider?.name || '—'}
                        {step.decided_at && <> · {formatRelative(step.decided_at)}</>}</>
                    )}
                  </div>
                  {step.note && (
                    <div style={{ fontSize: 12.5, color: 'var(--text-2)', background: 'var(--surface-2)', borderRadius: 6, padding: '6px 10px', marginTop: 6 }}>
                      {step.note}
                    </div>
                  )}
                </div>
              </div>
              )
            })}
        </div>

        {showReassign && (
          <div className="fgrp" style={{ marginBottom: 14 }}>
            <label className="flbl">Hand step {request.current_step} to</label>
            {!candidates ? (
              <span className="spin spin-dark" />
            ) : (
              <>
                <select className="finp" value={assignee}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAssignee(e.target.value)}>
                  <option value="">Choose an approver…</option>
                  {candidates.users.length > 0 && (
                    <optgroup label="People">
                      {candidates.users
                        .filter(u => u.id !== currentStep?.approver_user_id)
                        .map(u => <option key={u.id} value={`user:${u.id}`}>{u.name}</option>)}
                    </optgroup>
                  )}
                  {candidates.roles.length > 0 && (
                    <optgroup label="Anyone holding a role">
                      {candidates.roles
                        .filter(r => r.id !== currentStep?.approver_role_id)
                        .map(r => <option key={r.id} value={`role:${r.id}`}>Any {r.name}</option>)}
                    </optgroup>
                  )}
                </select>
                <input className="finp" style={{ marginTop: 8 }} maxLength={500} value={reassignReason}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReassignReason(e.target.value)}
                  placeholder="Reason (optional) — recorded in the audit log" />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={submitReassign} disabled={!assignee || !!acting}>
                    {acting === 'reassign' ? <span className="spin" /> : 'Reassign step'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowReassign(false)} disabled={!!acting}>Never mind</button>
                </div>
              </>
            )}
          </div>
        )}

        {canDecide && (
          <div className="fgrp">
            <label className="flbl">{showReject ? 'Reason for rejection' : 'Note (optional)'}</label>
            <textarea className="finp" rows={3} value={note} maxLength={2000}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
              placeholder={showReject ? 'Explain what needs to change before this can go out…' : 'Anything the requester should know about this sign-off…'} />
          </div>
        )}

        {isRequester && request.status === 'pending' && !request.allow_self_approval && !canDecide && (
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>
            You requested this — it needs to be decided by someone else.
          </p>
        )}

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canCancel && (
              // FIX (re-audit, section-11 finding): this only confirmed when sendFailed was
              // true — `!sendFailed || confirm(...)` short-circuits to true for an ordinary
              // pending request, so clicking Cancel on a still-in-flight (possibly multi-step,
              // partially-approved) chain cancelled it immediately with no confirmation at
              // all. Every other cancel entry point in the app (the send-failed banner above,
              // BillingTab's void/delete) confirms first. Confirm unconditionally now, with
              // wording that matches whichever state this actually is.
              <button className="btn btn-ghost" onClick={() => {
                if (confirm(cancelConfirmMessage(request.document_type, sendFailed))) act('cancel')
              }} disabled={!!acting}>
                {acting === 'cancel' ? <span className="spin" /> : 'Cancel request'}
              </button>
            )}
            {canReassign && !showReassign && (
              <button className="btn btn-ghost" onClick={openReassign} disabled={!!acting}>Reassign step</button>
            )}
            {canRetrySend && (
              <button className="btn btn-primary" onClick={() => act('retry-send')} disabled={!!acting}>
                {acting === 'retry-send' ? <span className="spin" /> : 'Retry send'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
            {canDecide && !showReject && (
              <>
                <button className="btn btn-ghost" onClick={() => setShowReject(true)} disabled={!!acting}>
                  Reject
                </button>
                <button className="btn btn-primary" onClick={() => act('approve', note.trim() ? { note: note.trim() } : {})} disabled={!!acting}>
                  {acting === 'approve' ? <span className="spin" /> : 'Approve'}
                </button>
              </>
            )}
            {canDecide && showReject && (
              <button className="btn btn-primary" onClick={() => act('reject', { note })} disabled={!!acting || !note.trim()}>
                {acting === 'reject' ? <span className="spin" /> : 'Submit rejection'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
