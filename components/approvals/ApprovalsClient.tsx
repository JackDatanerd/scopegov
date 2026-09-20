// components/approvals/ApprovalsClient.tsx
'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { SessionUser } from '@/lib/supabase/types'
import { formatCurrency, formatRelative } from '@/lib/utils/format'

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
  // FIX (section-11/12 audit): runtime values include 'co_counter'
  // (accepting a negotiated counter-offer) and 'invoice' — this type
  // previously omitted both.
  document_type: 'sow' | 'co' | 'co_counter' | 'invoice'
  document_id: string
  project_id: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  current_step: number
  total_steps: number
  context: { title?: string; amount?: number; currency?: string; project_name?: string }
  created_at: string
  decided_at: string | null
  requested_by: string
  // FIX (section-11 fix round, flagship finding): see migration 053 — set
  // when the auto-send that fires on final approval fails.
  send_failed_at: string | null
  send_failed_reason: string | null
  requester: { id: string; name: string; email: string } | null
  projects: { id: string; name: string } | null
  approval_steps: Step[]
}

function documentLabelFor(documentType: ApprovalRequest['document_type']): string {
  if (documentType === 'sow') return 'SOW'
  if (documentType === 'invoice') return 'Invoice'
  if (documentType === 'co_counter') return 'Change order counter-offer'
  return 'Change order'
}

// FIX (section-11 fix round, flagship feature gap): neither the table row
// nor the detail modal ever linked to the actual document being decided —
// an approver saw only a title string and a dollar figure, with no way to
// open the real SOW sections / CO line items / invoice before approving
// or rejecting it. canReadProject already gates who's allowed to decide
// (see recordApprovalDecision in lib/approvals/engine.ts), so anyone
// eligible to act here is already entitled to view the project's SOW/CO/
// billing tab — this was a pure UI omission, not a permissions gap.
function tabForDocumentType(documentType: ApprovalRequest['document_type']): string {
  if (documentType === 'sow') return 'sow'
  if (documentType === 'invoice') return 'billing'
  return 'co' // 'co' and 'co_counter' both live on the CO tab
}

// FIX (fix round, section-11 flagship finding): a send-failed request
// (status='approved', send_failed_at set) rendered as a plain "Approved"
// pill here — visually identical to a request that actually went out —
// so the one place meant to give a workspace-wide view of every approval
// request showed nothing to distinguish a silently-stuck one from a
// successful one.
function requestPill(status: string, sendFailed?: boolean): string {
  if (status === 'approved' && sendFailed) return 'red'
  const m: Record<string, string> = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: 'slate' }
  return m[status] || 'slate'
}
function requestLabel(status: string, sendFailed?: boolean): string {
  if (status === 'approved' && sendFailed) return 'Approved — not sent'
  const m: Record<string, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' }
  return m[status] || status
}

export default function ApprovalsClient({ session, canViewAll, canManageWorkflows }: {
  session: SessionUser; canViewAll: boolean; canManageWorkflows: boolean
}) {
  const searchParams = useSearchParams()
  const highlight = searchParams.get('highlight')

  const [tab, setTab] = useState<'mine' | 'all'>('mine')
  const [items, setItems] = useState<ApprovalRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<ApprovalRequest | null>(null)
  // FIX (section-11 fix round, flagship finding — completing the
  // send_failed_at fix): fetched independently of the mine/all tabs above,
  // since a request needing a retry belongs to the ORIGINAL REQUESTER —
  // who may hold neither the approving role ("mine") nor canViewAll
  // ("all"). Without this, an ordinary team member who just gets the
  // notification telling them to "open it in Approvals to retry" would
  // land on a page with no way to actually find their own request.
  const [needsRetry, setNeedsRetry] = useState<ApprovalRequest[]>([])
  const [retryingId, setRetryingId] = useState<string | null>(null)
  // FIX (fix round, section-11 finding): this used to be derived from
  // `items`, which only ever holds whichever tab is currently loaded —
  // so the count on the "My queue" button itself disappeared the moment
  // you switched to "All requests", unlike the Sidebar's badge (same
  // underlying number) which fetches independently and stays live no
  // matter what page or tab you're on. Fetched the same way here now.
  const [mineCount, setMineCount] = useState<number | null>(null)

  const loadMineCount = useCallback(async () => {
    try {
      const res  = await fetch('/api/approvals?scope=mine')
      const json = await res.json()
      if (!res.ok) return
      setMineCount((json.requests || []).filter((r: ApprovalRequest) => r.status === 'pending').length)
    } catch { /* non-fatal — the button just shows no count */ }
  }, [])

  const load = useCallback(async (scope: 'mine' | 'all') => {
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
      setNeedsRetry((json.requests || []).filter((r: ApprovalRequest) => !!r.send_failed_at))
    } catch { /* non-fatal — the notification is still the primary signal */ }
  }, [])

  useEffect(() => { load(tab) }, [tab, load])
  useEffect(() => { loadNeedsRetry() }, [loadNeedsRetry])
  useEffect(() => { loadMineCount() }, [loadMineCount])

  async function retrySend(id: string) {
    setRetryingId(id)
    try {
      const res  = await fetch(`/api/approvals/${id}/retry-send`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Retry failed')
      await Promise.all([load(tab), loadNeedsRetry(), loadMineCount()])
      window.dispatchEvent(new Event('scopegov:approvals-changed'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed')
    } finally { setRetryingId(null) }
  }

  // Auto-open the request linked from a notification.
  // FIX (Notifications & email fix round): ?highlight= only searched the tab that happened to be
  // loaded ("Assigned to me"), so a link to a request you SUBMITTED (approved / rejected / send
  // failed) or one you can only see under "All" opened the page and then did nothing. It now checks
  // the loaded tab, then requests you submitted, then (if you may) everything — once.
  const highlightTried = useRef<string | null>(null)
  useEffect(() => {
    if (!highlight || loading) return
    const local = items.find(r => r.id === highlight) || needsRetry.find(r => r.id === highlight)
    if (local) { setSelected(local); return }
    if (highlightTried.current === highlight) return
    highlightTried.current = highlight
    ;(async () => {
      for (const scope of (canViewAll ? ['submitted', 'all'] : ['submitted'])) {
        try {
          const res  = await fetch(`/api/approvals?scope=${scope}`)
          const json = await res.json()
          if (!res.ok) continue
          const found = (json.requests || []).find((r: ApprovalRequest) => r.id === highlight)
          if (found) { setSelected(found); return }
        } catch { /* try the next scope */ }
      }
    })()
  }, [highlight, items, needsRetry, loading, canViewAll])

  function myEligibleStep(r: ApprovalRequest): Step | null {
    const step = r.approval_steps.find(s => s.step_order === r.current_step)
    if (!step || step.status !== 'pending') return null
    if (step.approver_user_id) return step.approver_user_id === session.id ? step : null
    // Role-based eligibility is enforced server-side (we don't know the
    // viewer's role_id here) — the button just fires and the API is the
    // real gatekeeper if this optimistic check is ever wrong.
    return step
  }

  async function refreshAfterAction() {
    setSelected(null)
    await Promise.all([load(tab), loadMineCount()])
    // FIX (section-11 audit, flagship finding): Sidebar's pending-count
    // badge only ever refetched on a `pathname` change — approving/
    // rejecting/cancelling from this page doesn't navigate anywhere, so
    // the badge sat stale (still showing the pre-action count) for the
    // rest of the visit. Dispatch a plain DOM event Sidebar listens for,
    // rather than reaching for a heavier shared-state solution for what
    // is, in the whole app, a single cross-component refresh signal.
    window.dispatchEvent(new Event('scopegov:approvals-changed'))
  }

  const pendingMineCount = mineCount

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-sub">Sign-offs required before a SOW or change order reaches the client</p>
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
                <button className="btn btn-primary btn-sm" onClick={() => retrySend(r.id)} disabled={retryingId === r.id}>
                  {retryingId === r.id ? <span className="spin" /> : 'Retry send'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {canViewAll && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
          <button className={`btn btn-sm ${tab === 'mine' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('mine')}>
            My queue{pendingMineCount ? ` (${pendingMineCount})` : ''}
          </button>
          <button className={`btn btn-sm ${tab === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('all')}>
            All requests
          </button>
        </div>
      )}

      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

      {loading ? (
        <div className="surface"><div className="empty-state"><span className="spin spin-dark" /></div></div>
      ) : items.length === 0 ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-shield-check empty-state-icon" />
            <p className="empty-state-title">{tab === 'mine' ? 'Nothing waiting on you' : 'No approval requests yet'}</p>
            <p className="empty-state-sub">
              {tab === 'mine'
                ? 'Documents gated by an approval workflow will show up here when it\u2019s your turn to decide.'
                : 'Once a workflow is configured, SOWs and change orders that trip it will appear here.'}
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
              {items.map(r => (
                <tr key={r.id} onClick={() => setSelected(r)}>
                  <td>
                    <span style={{ fontWeight: 500 }}>{r.context?.title || documentLabelFor(r.document_type)}</span>
                    {/* FIX (section-11/12 audit, flagship finding): a
                        'co_counter' request (accepting a client's negotiated
                        counter-offer) or an 'invoice' request rendered an
                        identical "CO"/generic pill — no way to tell them
                        apart from this list. */}
                    <span className="pill pill-slate pill-sm" style={{ marginLeft: 8 }}>
                      {r.document_type === 'sow' ? 'SOW' : r.document_type === 'invoice' ? 'Invoice' : r.document_type === 'co_counter' ? 'CO counter' : 'CO'}
                    </span>
                  </td>
                  <td>{r.projects?.name || r.context?.project_name || '—'}</td>
                  <td>{r.requester?.name || '—'}</td>
                  <td style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12 }}>{r.current_step} / {r.total_steps}</td>
                  <td style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                    {r.context?.amount != null ? formatCurrency(r.context.amount, r.context.currency || 'USD') : '—'}
                  </td>
                  <td><span className={`pill pill-${requestPill(r.status, !!r.send_failed_at)}`}>{requestLabel(r.status, !!r.send_failed_at)}</span></td>
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
          eligibleStep={myEligibleStep(selected)}
          canManageWorkflows={canManageWorkflows}
          onClose={() => setSelected(null)}
          onDone={refreshAfterAction}
        />
      )}
    </div>
  )
}

function ApprovalDetailModal({ request, session, eligibleStep, canManageWorkflows, onClose, onDone }: {
  request: ApprovalRequest
  session: SessionUser
  eligibleStep: Step | null
  canManageWorkflows: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [acting, setActing]   = useState<'approve' | 'reject' | 'cancel' | 'retry-send' | null>(null)
  const [note, setNote]       = useState('')
  const [showReject, setShowReject] = useState(false)
  const [error, setError]     = useState('')

  const isRequester = request.requested_by === session.id
  // FIX (section-11/12 audit, flagship finding): document_type can also be
  // 'co_counter' (approving acceptance of a client's negotiated
  // counter-offer) or 'invoice' — collapsing either into plain "Change
  // order" made that decision indistinguishable from an ordinary CO send
  // approval. Mirrors the same fix in lib/approvals/engine.ts.
  const documentLabel = documentLabelFor(request.document_type)
  // FIX (fix round, section-11 finding): this only ever checked
  // isRequester — the retry-send/cancel API routes have always allowed a
  // MANAGE_WORKSPACE_SETTINGS admin to act on someone else's request (see
  // those routes' own comments), but the button to do either was never
  // rendered for that admin at all, since canManageWorkflows (already
  // passed into ApprovalsClient for the "Configure workflows" link) was
  // never threaded down into this modal. The API-level capability existed
  // but was completely unreachable from the product.
  const canCancel = (isRequester || canManageWorkflows) && request.status === 'pending'
  const canRetrySend = (isRequester || canManageWorkflows) && request.status === 'approved' && !!request.send_failed_at
  // FIX (section-11 audit, flagship finding): eligibleStep only ever
  // checked whether the signed-in member is the assigned approver
  // (named user or role) for the current step — never whether they're
  // also the person who requested this send. The server now rejects a
  // self-decision (see recordApprovalDecision), but the button was still
  // shown, live, to the requester whenever they also happened to hold
  // the approving role — clicking it just produced a confusing 403.
  // Suppress it client-side and say why.
  const selfApprovalBlocked = isRequester && !!eligibleStep

  async function act(action: 'approve' | 'reject' | 'cancel' | 'retry-send', body?: Record<string, unknown>) {
    setActing(action); setError('')
    try {
      const res  = await fetch(`/api/approvals/${request.id}/${action}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `Failed to ${action}`)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`)
    } finally { setActing(null) }
  }

  return (
    <>
      <div className="modal-bg" onClick={onClose} />
      <div className="modal modal-lg">
        <h2 className="modal-title">{request.context?.title || documentLabel}</h2>
        <p className="modal-sub">
          {documentLabel} on {request.projects?.name || request.context?.project_name} · requested by {request.requester?.name}
          {request.context?.amount != null && <> · {formatCurrency(request.context.amount, request.context.currency || 'USD')}</>}
        </p>
        {request.projects?.id && (
          <p className="modal-sub" style={{ marginTop: -8, marginBottom: 14 }}>
            <Link href={`/projects/${request.projects.id}?tab=${tabForDocumentType(request.document_type)}`} target="_blank" rel="noreferrer">
              <i className="ti ti-external-link" style={{ fontSize: 11 }} /> Open the {documentLabel.toLowerCase()} to review before deciding
            </Link>
          </p>
        )}

        {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

        {/* FIX (fix round, section-11 flagship finding): before this, a
            fully-approved-but-send-failed request looked identical to an
            ordinary successful "Approved" one everywhere in this table —
            this banner and the retry button below are the only place in
            the whole product (besides the original requester's one-time
            email) that ever surfaces this state or offers a way to fix it. */}
        {request.status === 'approved' && request.send_failed_at && (
          <div className="auth-error" style={{ marginBottom: 14 }}>
            <strong>Approved, but couldn&apos;t be sent.</strong> {request.send_failed_reason || 'The send failed.'}
          </div>
        )}

        <div style={{ marginBottom: 18 }}>
          {request.approval_steps
            .slice()
            .sort((a, b) => a.step_order - b.step_order)
            .map(step => (
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
                    : step.status === 'skipped' ? 'var(--surface-2)' : 'var(--amber-lt)',
                  color: step.status === 'approved' ? 'var(--green)'
                    : step.status === 'rejected' ? 'var(--red)'
                    : step.status === 'skipped' ? 'var(--text-4)' : 'var(--amber)',
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
                    {step.status === 'pending' && 'Awaiting decision'}
                    {step.status === 'skipped' && 'Skipped — request cancelled'}
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
            ))}
        </div>

        {showReject && (
          <div className="fgrp">
            <label className="flbl">Reason for rejection</label>
            <textarea className="finp" rows={3} value={note} autoFocus
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
              placeholder="Explain what needs to change before this can go out…" />
          </div>
        )}

        {selfApprovalBlocked && (
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>
            You requested this — it needs to be decided by someone else.
          </p>
        )}

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div>
            {canCancel && (
              <button className="btn btn-ghost" onClick={() => act('cancel')} disabled={!!acting}>
                {acting === 'cancel' ? <span className="spin" /> : 'Cancel request'}
              </button>
            )}
            {canRetrySend && (
              <button className="btn btn-primary" onClick={() => act('retry-send')} disabled={!!acting}>
                {acting === 'retry-send' ? <span className="spin" /> : 'Retry send'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
            {eligibleStep && !selfApprovalBlocked && !showReject && (
              <>
                <button className="btn btn-ghost" onClick={() => setShowReject(true)} disabled={!!acting}>
                  Reject
                </button>
                <button className="btn btn-primary" onClick={() => act('approve')} disabled={!!acting}>
                  {acting === 'approve' ? <span className="spin" /> : 'Approve'}
                </button>
              </>
            )}
            {eligibleStep && !selfApprovalBlocked && showReject && (
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
