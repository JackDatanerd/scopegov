'use client'
// Edit a project's details.
//
// FEATURE GAP closed (Projects & Dashboard deep audit): PATCH /api/projects/[id]
// has always existed, but NOTHING in the UI called it — a mistyped name or
// contract value, or a retainer's duration ("Not set — monthly billing won't
// auto-generate" on the Overview tab), could not be corrected by anyone.
// The rules the API enforces are mirrored here so the form doesn't offer
// what the server will refuse.
//
// FEATURE GAP closed (fix round, Projects & Dashboard section 7): the same
// PATCH route has always accepted `clientId` too — validated, workspace-
// scoped, blocked once a SOW exists (same structural-edit rule as type and
// currency) — but this modal never exposed it. A project attached to the
// wrong client at intake, before any SOW exists, had no way to be corrected
// short of deleting and recreating the whole project. The search/select UI
// below mirrors app/(app)/projects/new/page.tsx's client picker; it's
// deliberately narrower — existing clients only, no "+ New client" — since
// this is a correction to an already-created project, not intake.
//
// FEATURE GAP closed (re-audit, Projects & Dashboard section 7): the API's
// structural-edit rule (`clientId`/`type`/`currency`, all blocked once a SOW
// exists) treats all three fields identically, but this modal only ever
// exposed client and currency — `type` itself had no editor at all, so a
// project picked as the wrong type at intake (e.g. "web" meant to be
// "retainer") had no correction path short of delete-and-recreate. Uses the
// same PROJECT_TYPES list app/(app)/projects/new/page.tsx's picker uses, and
// the same `hasAnySow` gate as client/currency above it.

import { useState, useEffect } from 'react'
import { CURRENCIES } from '@/lib/constants/workspace-options'
import { PROJECT_TYPE_LABELS } from '@/lib/utils/format'
import { PROJECT_TYPES } from '@/lib/utils/project-input'
import type { Client, ProjectType } from '@/lib/supabase/types'

export default function EditProjectModal({
  project, canViewFinancials, onClose, onSaved,
}: {
  project: any
  canViewFinancials: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const sows: Array<{ status: string }> = project.sow_documents || []
  const hasAnySow = sows.length > 0
  // Same rules as the API: a signed SOW binds the value (use a change order),
  // and a SOW out for signature quotes the current value.
  // FIX (Projects & Dashboard deep audit, flagship finding): for a retainer,
  // the duration is as much a value field as the monthly amount — total =
  // amount × months (see the label just below) — so it must be locked by the
  // exact same rule, not left freely editable once a SOW exists. Reused
  // (rather than a second, parallel variable) so the two fields can never
  // drift out of sync with each other or with the API's own guard.
  const valueLocked = sows.some(s => ['signed', 'awaiting_signature', 'changes_requested'].includes(s.status))
  const valueLockReason = sows.some(s => s.status === 'signed')
    ? 'This project has a signed SOW — use a change order to adjust the value or retainer duration.'
    : 'A SOW is out for signature at this value — withdraw it before changing the value or retainer duration.'

  const [name, setName] = useState<string>(project.name || '')
  const [type, setType] = useState<ProjectType>(project.type)
  const [disc, setDisc] = useState<string>(project.disc || '')
  const [contractValue, setContractValue] = useState<string>(
    project.contract_value !== null && project.contract_value !== undefined ? String(project.contract_value) : ''
  )
  const [currency, setCurrency] = useState<string>(project.currency || 'USD')
  const [startDate, setStartDate] = useState<string>(project.start_date || '')
  const [internalRef, setInternalRef] = useState<string>(project.internal_ref || '')
  const [retainerMonths, setRetainerMonths] = useState<string>(
    project.retainer_duration_months ? String(project.retainer_duration_months) : ''
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Client reassignment — existing clients only, gated the same way the API
  // gates it (no SOW yet). Only fetched when the field can actually be used.
  const [clientId, setClientId] = useState<string>(project.client_id || '')
  const [clientSearch, setClientSearch] = useState('')
  const [clients, setClients] = useState<Client[]>([])
  useEffect(() => {
    if (hasAnySow) return
    fetch('/api/clients').then(r => r.json()).then(json => {
      setClients(json.clients || [])
    }).catch(() => {})
  }, [hasAnySow])
  const filteredClients = clientSearch
    ? clients.filter(c =>
        c.id !== clientId &&
        (c.name.toLowerCase().includes(clientSearch.toLowerCase()) ||
         c.email?.toLowerCase().includes(clientSearch.toLowerCase()))
      )
    : []
  const selectedClient = clients.find(c => c.id === clientId)
  const selectedClientLabel = selectedClient?.name || project.clients?.name || ''

  async function save() {
    setError('')
    if (!name.trim()) { setError('Project name is required'); return }
    // Only send what actually changed, so an untouched locked field can't make
    // the whole save fail.
    const body: Record<string, unknown> = {}
    if (name.trim() !== project.name) body.name = name.trim()
    if (disc.trim() !== (project.disc || '')) body.disc = disc.trim()
    if (startDate !== (project.start_date || '')) body.startDate = startDate
    if (internalRef.trim() !== (project.internal_ref || '')) body.internalRef = internalRef.trim()
    // FIX (fix round, Projects & Dashboard section 7): this used to skip
    // sending contractValue whenever the field was blank, so clearing it
    // (to zero out a project, e.g. converting to pro-bono) silently no-op'd
    // — the save appeared to succeed but the old value stayed. The API's
    // parseContractValue already treats '' as a valid 0; retainerMonths
    // below handles its own "clear to empty" case correctly, this didn't.
    const contractValueNum = contractValue.trim() === '' ? 0 : Number(contractValue)
    if (canViewFinancials && !valueLocked && contractValueNum !== Number(project.contract_value || 0)) {
      body.contractValue = contractValue.trim()
    }
    if (!hasAnySow && currency !== (project.currency || 'USD')) body.currency = currency
    if (!hasAnySow && clientId && clientId !== project.client_id) body.clientId = clientId
    // Same structural-edit gate as client/currency: the API blocks a type
    // change once a SOW exists (see PATCH /api/projects/[id]).
    if (!hasAnySow && type !== project.type) body.type = type
    // retainerMonths is only meaningful (and only shown below) for the
    // CURRENTLY SELECTED type, not the project's original one — a type
    // switch away from retainer clears it server-side automatically
    // (see PATCH's own retainer_duration_months reset), and a switch INTO
    // retainer needs the field to actually be sendable.
    // FIX (Projects & Dashboard deep audit, flagship finding): gated on
    // !valueLocked, same as contractValue above — this used to send whatever
    // was typed regardless of SOW state, silently re-pricing a signed
    // retainer with no change order, no approval, and no client
    // re-acceptance. A type switch INTO retainer can't itself be locked (a
    // structural edit like that is only reachable pre-SOW in the first
    // place — see !hasAnySow above), so this only ever actually blocks an
    // existing retainer's own duration.
    if (type === 'retainer' && !valueLocked && retainerMonths !== (project.type === 'retainer' && project.retainer_duration_months ? String(project.retainer_duration_months) : '')) {
      body.retainerDurationMonths = retainerMonths
    }
    if (Object.keys(body).length === 0) { onClose(); return }

    setBusy(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not save the changes')
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the changes')
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Edit project</h2>
        <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 14 }}>
          Changes are recorded in the activity log.
        </p>

        <label className="form-label">Project name</label>
        <input className="form-input" value={name} maxLength={200} onChange={e => setName(e.target.value)} style={{ marginBottom: 12 }} />

        <label className="form-label">Project type</label>
        {hasAnySow ? (
          <p style={{ fontSize: 12.5, marginBottom: 12 }}>
            {PROJECT_TYPE_LABELS[project.type] || project.type}
            <span style={{ fontSize: 11.5, color: 'var(--text-3)', display: 'block', marginTop: 2 }}>
              Type is fixed once a SOW exists.
            </span>
          </p>
        ) : (
          <select className="form-input" value={type} style={{ marginBottom: 12 }}
            onChange={e => setType(e.target.value as ProjectType)}>
            {PROJECT_TYPES.map(t => <option key={t} value={t}>{PROJECT_TYPE_LABELS[t] || t}</option>)}
          </select>
        )}

        <label className="form-label">Client</label>
        {hasAnySow ? (
          <p style={{ fontSize: 12.5, marginBottom: 12 }}>
            {project.clients?.name}
            <span style={{ fontSize: 11.5, color: 'var(--text-3)', display: 'block', marginTop: 2 }}>
              Client is fixed once a SOW exists.
            </span>
          </p>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <input className="form-input" placeholder="Search existing clients…" value={clientSearch}
              onChange={e => setClientSearch(e.target.value)} />
            {clientSearch && (
              <div className="surface" style={{ marginTop: 4, maxHeight: 160, overflowY: 'auto', position: 'relative', zIndex: 10 }}>
                {filteredClients.length === 0 ? (
                  <div style={{ padding: '10px 12px' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-3)' }}>No match.</span>
                  </div>
                ) : (
                  filteredClients.map(c => (
                    <button key={c.id} type="button"
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', borderBottom: '1px solid var(--surface-2)' }}
                      onClick={() => { setClientId(c.id); setClientSearch('') }}>
                      <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {c.name}
                        {c.status === 'archived' && <span className="pill pill-slate pill-sm">Archived</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{c.email}</div>
                    </button>
                  ))
                )}
              </div>
            )}
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="pill pill-green"><i className="ti ti-check" style={{ fontSize: 10 }} /> {selectedClientLabel}</span>
              {clientId !== project.client_id && (
                <button type="button" className="auth-link" style={{ fontSize: 11, background: 'none', border: 'none', padding: 0 }}
                  onClick={() => { setClientId(project.client_id || ''); setClientSearch('') }}>Undo</button>
              )}
            </div>
          </div>
        )}

        <label className="form-label">Subtitle (optional)</label>
        <input className="form-input" value={disc} maxLength={300} onChange={e => setDisc(e.target.value)} style={{ marginBottom: 12 }} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 10, marginBottom: 12 }}>
          {canViewFinancials ? (
            <div>
              <label className="form-label">{type === 'retainer' ? 'Monthly retainer amount' : 'Contract value'}</label>
              <input className="form-input" inputMode="decimal" value={contractValue} disabled={valueLocked}
                onChange={e => setContractValue(e.target.value)} />
              {type === 'retainer' && (
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  Billed every month — for the retainer duration below (total = monthly amount × months), or until the project is completed or archived if you leave the duration blank.
                </div>
              )}
            </div>
          ) : <div />}
          <div>
            <label className="form-label">Currency</label>
            <select className="form-input" value={currency} disabled={hasAnySow} onChange={e => setCurrency(e.target.value)}>
              {Array.from(new Set([currency, ...CURRENCIES])).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        {canViewFinancials && valueLocked && (
          <p style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '-6px 0 12px' }}>{valueLockReason}</p>
        )}
        {hasAnySow && (
          <p style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '-6px 0 12px' }}>
            Currency is fixed once a SOW exists.
          </p>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label className="form-label">Start date</label>
            <input type="date" className="form-input" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="form-label">Internal reference</label>
            <input className="form-input" value={internalRef} maxLength={100} onChange={e => setInternalRef(e.target.value)} placeholder="PO / job number" />
          </div>
        </div>

        {type === 'retainer' && (
          <div style={{ marginBottom: 12 }}>
            <label className="form-label">Retainer duration (months)</label>
            {/* FIX (Projects & Dashboard deep audit, flagship finding): disabled
                by the same valueLocked rule as the monthly amount above — total
                value = amount × months, so this field must be locked exactly
                when the amount is, not left freely editable once a SOW exists. */}
            <input className="form-input" inputMode="numeric" value={retainerMonths} style={{ maxWidth: 140 }} disabled={valueLocked}
              onChange={e => setRetainerMonths(e.target.value.replace(/[^0-9]/g, ''))} placeholder="e.g. 12" />
            {/* The lock reason itself is already shown once, above, right under the amount field
                (line ~243) — repeating the same sentence here would just be noise. */}
            {!valueLocked && (
              <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4 }}>
                Monthly billing milestones are generated for this many months.
              </p>
            )}
          </div>
        )}

        {error && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
            {busy ? <span className="spin" /> : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
