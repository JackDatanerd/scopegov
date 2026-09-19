// components/settings/ApprovalWorkflowsClient.tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/utils/format'
// FIX (section-11 audit): this file hardcoded its own 8-currency list,
// missing CAD/AUD — both valid per this single source of truth (already
// used by onboarding and, since a separate fix, Settings' own workspace
// currency picker). A CAD/AUD workspace could never configure a value-
// threshold workflow that actually matches its own documents' currency.
import { CURRENCIES } from '@/lib/constants/workspace-options'

interface Role { id: string; name: string; canApprove: boolean }
interface Member { id: string; name: string; email: string; canApprove: boolean }
interface WorkflowStep {
  id: string
  step_order: number
  approver_role_id: string | null
  approver_user_id: string | null
  roles: { id: string; name: string } | null
  user: { id: string; name: string; email: string } | null
}
interface Workflow {
  id: string
  document_type: 'sow' | 'co' | 'invoice'
  name: string
  threshold_amount: number | null
  threshold_currency: string | null
  is_active: boolean
  created_at: string
  approval_workflow_steps: WorkflowStep[]
}

// FIX (section-12 audit — flagship feature gap): 'invoice' added as a
// third gateable document type alongside 'sow'/'co' — see
// lib/approvals/engine.ts for the full context. Centralized here since
// this component previously spelled out "SOW"/"change order" labels
// inline in half a dozen places via a two-way ternary.
const TYPE_LABEL: Record<'sow' | 'co' | 'invoice', { singular: string; plural: string }> = {
  sow:     { singular: 'SOW', plural: 'SOWs' },
  co:      { singular: 'change order', plural: 'change orders' },
  invoice: { singular: 'invoice', plural: 'invoices' },
}

type StepDraft = { key: string; kind: 'role' | 'user' | ''; id: string }

function newStep(): StepDraft {
  return { key: Math.random().toString(36).slice(2), kind: '', id: '' }
}

export default function ApprovalWorkflowsClient({ initialWorkflows, roles, members, workspaceCurrency }: {
  initialWorkflows: Workflow[]; roles: Role[]; members: Member[]; workspaceCurrency?: string
}) {
  const router = useRouter()
  const [workflows, setWorkflows] = useState<Workflow[]>(initialWorkflows)
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  function refresh() { router.refresh() }

  async function toggleActive(w: Workflow) {
    setBusyId(w.id); setError('')
    const nextActive = !w.is_active
    try {
      const res = await fetch(`/api/approval-workflows/${w.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: nextActive }),
      })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      setWorkflows(ws => ws.map(x => x.id === w.id ? { ...x, is_active: nextActive } : x))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    } finally { setBusyId(null) }
  }

  async function remove(w: Workflow) {
    if (!confirm(`Remove "${w.name}"? If it has approval history it will be deactivated instead of deleted.`)) return
    setBusyId(w.id); setError('')
    try {
      const res = await fetch(`/api/approval-workflows/${w.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      if (json.deactivatedInstead) {
        setWorkflows(ws => ws.map(x => x.id === w.id ? { ...x, is_active: false } : x))
      } else {
        setWorkflows(ws => ws.filter(x => x.id !== w.id))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove')
    } finally { setBusyId(null) }
  }

  const byType = { sow: workflows.filter(w => w.document_type === 'sow'), co: workflows.filter(w => w.document_type === 'co'), invoice: workflows.filter(w => w.document_type === 'invoice') }

  return (
    <div>
      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

      {(['sow', 'co', 'invoice'] as const).map(type => (
        <div key={type} style={{ marginBottom: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 className="sec-title" style={{ margin: 0 }}>{TYPE_LABEL[type].singular === 'SOW' ? 'SOW workflows' : `${TYPE_LABEL[type].singular[0].toUpperCase()}${TYPE_LABEL[type].singular.slice(1)} workflows`}</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing('new-' + type as any)}>
              <i className="ti ti-plus" style={{ fontSize: 12 }} /> New workflow
            </button>
          </div>

          {byType[type].length === 0 ? (
            <div className="surface">
              <div className="empty-state" style={{ padding: '28px 20px' }}>
                <p className="empty-state-sub" style={{ margin: 0 }}>
                  No approval rules for {TYPE_LABEL[type].plural} yet — they send immediately once a client-facing draft is ready.
                </p>
              </div>
            </div>
          ) : (
            <div className="surface" style={{ overflow: 'hidden' }}>
              {byType[type].map(w => (
                <div key={w.id} style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px',
                  borderBottom: '1px solid var(--surface-2)', opacity: w.is_active ? 1 : 0.55,
                }}>
                  <button
                    className={`toggle ${w.is_active ? 'on' : 'off'}`}
                    onClick={() => toggleActive(w)}
                    disabled={busyId === w.id}
                    title={w.is_active ? 'Active — click to pause' : 'Paused — click to enable'}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>{w.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {w.threshold_amount != null
                        ? `Applies at ${formatCurrency(w.threshold_amount, w.threshold_currency || 'USD')} and above (${w.threshold_currency || 'USD'} only)`
                        : 'Applies to every document of this type'}
                      {' · '}
                      {w.approval_workflow_steps.length} step{w.approval_workflow_steps.length !== 1 ? 's' : ''}:{' '}
                      {w.approval_workflow_steps
                        .slice().sort((a, b) => a.step_order - b.step_order)
                        .map(s => s.roles?.name || s.user?.name || '—').join(' → ')}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(w)}>Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => remove(w)} disabled={busyId === w.id}>
                    <i className="ti ti-trash" style={{ fontSize: 12 }} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {editing && (
        <WorkflowEditorModal
          workflow={typeof editing === 'string' ? null : editing}
          defaultType={typeof editing === 'string' && editing.startsWith('new-co') ? 'co' : typeof editing === 'string' && editing.startsWith('new-invoice') ? 'invoice' : 'sow'}
          roles={roles}
          members={members}
          workspaceCurrency={workspaceCurrency}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh() }}
        />
      )}
    </div>
  )
}

function WorkflowEditorModal({ workflow, defaultType, roles, members, workspaceCurrency, onClose, onSaved }: {
  workflow: Workflow | null
  defaultType: 'sow' | 'co' | 'invoice'
  roles: Role[]; members: Member[]; workspaceCurrency?: string
  onClose: () => void; onSaved: () => void
}) {
  const isEdit = !!workflow
  const [documentType] = useState<'sow' | 'co' | 'invoice'>(workflow?.document_type || defaultType)
  const [name, setName] = useState(workflow?.name || '')
  const [hasThreshold, setHasThreshold] = useState(workflow?.threshold_amount != null)
  const [threshold, setThreshold] = useState(workflow?.threshold_amount != null ? String(workflow.threshold_amount) : '')
  // FIX (fix round, section-11 finding): this used to default to a
  // hardcoded 'USD' for every new workflow, regardless of the workspace's
  // actual currency (never fetched on this page before). Threshold
  // matching is strictly currency-isolated by design (migration 023) — a
  // KES-only workspace that forgot to change this dropdown got a rule
  // that silently never matched a single document, with nothing anywhere
  // warning them. Defaults to the workspace's own currency now; still
  // freely changeable for a workspace that genuinely bills in more than
  // one currency.
  const [thresholdCurrency, setThresholdCurrency] = useState(workflow?.threshold_currency || workspaceCurrency || 'USD')
  const [steps, setSteps] = useState<StepDraft[]>(
    workflow
      ? workflow.approval_workflow_steps
          .slice().sort((a, b) => a.step_order - b.step_order)
          .map(s => ({ key: s.id, kind: s.approver_role_id ? 'role' : 'user', id: (s.approver_role_id || s.approver_user_id)! }))
      : [newStep()]
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function updateStep(key: string, patch: Partial<StepDraft>) {
    setSteps(ss => ss.map(s => s.key === key ? { ...s, ...patch } : s))
  }
  function addStep() { setSteps(ss => [...ss, newStep()]) }
  function removeStep(key: string) { setSteps(ss => ss.filter(s => s.key !== key)) }
  function moveStep(key: string, dir: -1 | 1) {
    setSteps(ss => {
      const i = ss.findIndex(s => s.key === key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= ss.length) return ss
      const copy = ss.slice()
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return copy
    })
  }

  async function save() {
    setError('')
    if (!name.trim()) { setError('Give this workflow a name'); return }
    const cleanSteps = steps.filter(s => s.kind && s.id)
    if (cleanSteps.length === 0) { setError('Add at least one approver'); return }
    if (cleanSteps.length !== steps.length) { setError('Every step needs an approver selected'); return }

    setSaving(true)
    try {
      const payload = {
        documentType: documentType,
        name: name.trim(),
        thresholdAmount: hasThreshold && threshold !== '' ? Number(threshold) : null,
        thresholdCurrency: hasThreshold && threshold !== '' ? thresholdCurrency : null,
        steps: cleanSteps.map(s => s.kind === 'role' ? { approverRoleId: s.id } : { approverUserId: s.id }),
      }
      const res = await fetch(isEdit ? `/api/approval-workflows/${workflow!.id}` : '/api/approval-workflows', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to save')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally { setSaving(false) }
  }

  return (
    <>
      <div className="modal-bg" onClick={onClose} />
      <div className="modal modal-lg">
        <h2 className="modal-title">{isEdit ? 'Edit workflow' : `New ${TYPE_LABEL[documentType].singular} workflow`}</h2>
        <p className="modal-sub">
          {TYPE_LABEL[documentType].plural[0].toUpperCase()}{TYPE_LABEL[documentType].plural.slice(1)} matching this rule are held for sign-off before they can be sent to a client.
        </p>

        {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

        <div className="fgrp">
          <label className="flbl">Name</label>
          <input className="finp" value={name} onChange={e => setName(e.target.value)}
            placeholder={documentType === 'sow' ? 'e.g. SOWs over $25k' : documentType === 'invoice' ? 'e.g. Invoices over $10k' : 'e.g. All change orders'} />
        </div>

        <div className="fgrp">
          <label className="flbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={hasThreshold} onChange={e => setHasThreshold(e.target.checked)} />
            Only apply above a value threshold
          </label>
          {hasThreshold && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <select className="finp" value={thresholdCurrency} onChange={e => setThresholdCurrency(e.target.value)} style={{ maxWidth: 90 }}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <input className="finp" type="number" min="0" value={threshold}
                onChange={e => setThreshold(e.target.value)} placeholder="25000" style={{ maxWidth: 200 }} />
            </div>
          )}
          <p className="fhint">
            {hasThreshold
              ? `Leave off and this rule catches everything of this document type instead. Only matches documents in ${thresholdCurrency} — a document in another currency won't be gated by this rule.`
              : 'Applies to every document of this type, regardless of value or currency.'}
          </p>
        </div>

        <div className="fgrp">
          <label className="flbl">Approval steps</label>
          <p className="fhint" style={{ marginTop: -2, marginBottom: 10 }}>
            Each step must clear before the next one is notified. Pick a specific person, or a role — any active member holding that role can act on it.
          </p>
          {steps.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{
                width: 22, height: 22, borderRadius: '50%', background: 'var(--surface-2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, flexShrink: 0,
              }}>{i + 1}</span>
              <select className="finp" style={{ maxWidth: 110 }}
                value={s.kind}
                onChange={e => updateStep(s.key, { kind: e.target.value as StepDraft['kind'], id: '' })}>
                <option value="">Approver type…</option>
                <option value="role">Role</option>
                <option value="user">Person</option>
              </select>
              {s.kind === 'role' && (
                <select className="finp" value={s.id} onChange={e => updateStep(s.key, { id: e.target.value })}>
                  <option value="">Select role…</option>
                  {/* FIX (section-11 audit, flagship finding): roles that
                      don't hold APPROVE_DOCUMENTS are still listed — hiding
                      them would make an already-broken step's current
                      selection disappear from its own dropdown — but
                      flagged and disabled so a NEW pick can't recreate the
                      same dead-end, while an existing broken one stays
                      visible for the admin to notice and fix. */}
                  {roles.map(r => (
                    <option key={r.id} value={r.id} disabled={!r.canApprove && r.id !== s.id}>
                      {r.name}{!r.canApprove ? ' (can\u2019t approve — missing permission)' : ''}
                    </option>
                  ))}
                </select>
              )}
              {s.kind === 'user' && (
                <select className="finp" value={s.id} onChange={e => updateStep(s.key, { id: e.target.value })}>
                  <option value="">Select person…</option>
                  {members.map(m => (
                    <option key={m.id} value={m.id} disabled={!m.canApprove && m.id !== s.id}>
                      {m.name}{!m.canApprove ? ' (can\u2019t approve — missing permission)' : ''}
                    </option>
                  ))}
                </select>
              )}
              <div style={{ display: 'flex', gap: 2, marginLeft: 'auto', flexShrink: 0 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => moveStep(s.key, -1)} disabled={i === 0} title="Move up">
                  <i className="ti ti-chevron-up" style={{ fontSize: 12 }} />
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => moveStep(s.key, 1)} disabled={i === steps.length - 1} title="Move down">
                  <i className="ti ti-chevron-down" style={{ fontSize: 12 }} />
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => removeStep(s.key)} disabled={steps.length === 1} title="Remove step">
                  <i className="ti ti-x" style={{ fontSize: 12 }} />
                </button>
              </div>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={addStep}>
            <i className="ti ti-plus" style={{ fontSize: 12 }} /> Add step
          </button>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <span className="spin" /> : isEdit ? 'Save changes' : 'Create workflow'}
          </button>
        </div>
      </div>
    </>
  )
}
