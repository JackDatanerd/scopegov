// components/approvals/ApprovalsClient.tsx
'use client'
import { useState, useEffect, useCallback } from 'react'
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

function requestPill(status: string): string {
  const m: Record<string, string> = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: 'slate' }
  return m[status] || 'slate'
}
function requestLabel(status: string): string {
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

  useEffect(() => { load(tab) }, [tab, load])

  // Auto-open the request linked from a notification.
  useEffect(() => {
    if (highlight && items.length > 0) {
      const match = items.find(r => r.id === highlight)
      if (match) setSelected(match)
    }
  }, [highlight, items])

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
    await load(tab)
    // FIX (section-11 audit, flagship finding): Sidebar's pending-count
    // badge only ever refetched on a `pathname` change — approving/
    // rejecting/cancelling from this page doesn't navigate anywhere, so
    // the badge sat stale (still showing the pre-action count) for the
    // rest of the visit. Dispatch a plain DOM event Sidebar listens for,
    // rather than reaching for a heavier shared-state solution for what
    // is, in the whole app, a single cross-component refresh signal.
    window.dispatchEvent(new Event('scopegov:approvals-changed'))
  }

  const pendingMineCount = tab === 'mine' ? items.filter(r => r.status === 'pending').length : null

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
                  <td><span className={`pill pill-${requestPill(r.status)}`}>{requestLabel(r.status)}</span></td>
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
          onClose={() => setSelected(null)}
          onDone={refreshAfterAction}
        />
      )}
    </div>
  )
}

function ApprovalDetailModal({ request, session, eligibleStep, onClose, onDone }: {
  request: ApprovalRequest
  session: SessionUser
  eligibleStep: Step | null
  onClose: () => void
  onDone: () => void
}) {
  const [acting, setActing]   = useState<'approve' | 'reject' | 'cancel' | null>(null)
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
  const canCancel = isRequester && request.status === 'pending'
  // FIX (section-11 audit, flagship finding): eligibleStep only ever
  // checked whether the signed-in member is the assigned approver
  // (named user or role) for the current step — never whether they're
  // also the person who requested this send. The server now rejects a
  // self-decision (see recordApprovalDecision), but the button was still
  // shown, live, to the requester whenever they also happened to hold
  // the approving role — clicking it just produced a confusing 403.
  // Suppress it client-side and say why.
  const selfApprovalBlocked = isRequester && !!eligibleStep

  async function act(action: 'approve' | 'reject' | 'cancel', body?: Record<string, unknown>) {
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

        {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

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
