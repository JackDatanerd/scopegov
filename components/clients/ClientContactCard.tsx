// components/clients/ClientContactCard.tsx
//
// FIX (audit round 6): api/clients/[id]/route.ts PATCH has supported
// editing name, companyName, email, phone, timezone, notes,
// paymentTermsNote, and (as of this fix round) ccEmails since it was
// written — but BillingDetailsCard was the *only* UI ever wired to that
// route, and it only ever sends billingAddress/vatNumber. Every other
// field was permanently stuck at whatever was typed at creation, with no
// way to fix a typo or update a contact's email. This card is the missing
// edit surface for everything BillingDetailsCard doesn't cover.

'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  clientId: string
  name: string
  companyName: string | null
  email: string | null
  phone: string | null
  ccEmails: string[] | null
  paymentTermsNote: string | null
  notes: string | null
  editable: boolean
}

export default function ClientContactCard({
  clientId, name, companyName, email, phone, ccEmails, paymentTermsNote, notes, editable,
}: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  const [form, setForm] = useState({
    name: name || '',
    companyName: companyName || '',
    email: email || '',
    phone: phone || '',
    ccEmails: (ccEmails || []).join(', '),
    paymentTermsNote: paymentTermsNote || '',
    notes: notes || '',
  })

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm(f => ({ ...f, [key]: value }))
  }

  async function save() {
    setSaving(true); setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name, companyName: form.companyName, email: form.email,
          phone: form.phone, ccEmails: form.ccEmails, paymentTermsNote: form.paymentTermsNote,
          notes: form.notes,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setEditing(false)
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally { setSaving(false) }
  }

  if (!editing) {
    return (
      <div className="surface surface-p" style={{ marginBottom: 16 }}>
        <div className="sec-hd" style={{ marginBottom: 10 }}>
          <div className="sec-title">Contact details</div>
          {editable && (
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
          )}
        </div>
        <div className="settings-row" style={{ paddingTop: 0 }}>
          <span className="settings-row-key" style={{ fontSize: 12 }}>Email</span>
          <a href={`mailto:${email}`} style={{ fontSize: 13, color: 'var(--green)' }}>{email}</a>
        </div>
        {phone && (
          <div className="settings-row">
            <span className="settings-row-key" style={{ fontSize: 12 }}>Phone</span>
            <span className="settings-row-val">{phone}</span>
          </div>
        )}
        {ccEmails && ccEmails.length > 0 && (
          <div className="settings-row">
            <span className="settings-row-key" style={{ fontSize: 12 }}>CC</span>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{ccEmails.join(', ')}</div>
          </div>
        )}
        {paymentTermsNote && (
          <div className="settings-row" style={{ paddingBottom: 0, borderBottom: 'none' }}>
            <span className="settings-row-key" style={{ fontSize: 12 }}>Payment terms</span>
            <span className="settings-row-val" style={{ fontSize: 11 }}>{paymentTermsNote}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="surface surface-p" style={{ marginBottom: 16 }}>
      <div className="sec-hd" style={{ marginBottom: 10 }}>
        <div className="sec-title">Contact details</div>
      </div>
      {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}
      <div className="f2">
        <div className="fgrp">
          <label className="flbl">Client name</label>
          <input className="finp" value={form.name} onChange={e => set('name', e.target.value)} />
        </div>
        <div className="fgrp">
          <label className="flbl">Company <span className="fhint">— optional</span></label>
          <input className="finp" value={form.companyName} onChange={e => set('companyName', e.target.value)} />
        </div>
      </div>
      <div className="f2">
        <div className="fgrp">
          <label className="flbl">Email</label>
          <input type="email" className="finp" value={form.email} onChange={e => set('email', e.target.value)} />
        </div>
        <div className="fgrp">
          <label className="flbl">Phone <span className="fhint">— optional</span></label>
          <input className="finp" value={form.phone} onChange={e => set('phone', e.target.value)} />
        </div>
      </div>
      <div className="fgrp">
        <label className="flbl">CC on emails <span className="fhint">— optional, comma-separated</span></label>
        <input className="finp" value={form.ccEmails} onChange={e => set('ccEmails', e.target.value)}
          placeholder="finance@acme.com, legal@acme.com" />
      </div>
      <div className="fgrp">
        <label className="flbl">Payment terms note <span className="fhint">— optional</span></label>
        <input className="finp" value={form.paymentTermsNote} onChange={e => set('paymentTermsNote', e.target.value)}
          placeholder="Net 30, wire only" />
      </div>
      <div className="fgrp">
        <label className="flbl">Internal notes <span className="fhint">— optional, not shown to the client</span></label>
        <textarea className="finp" rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} />
      </div>
      <div className="modal-footer" style={{ justifyContent: 'flex-start', gap: 8, paddingLeft: 0 }}>
        <button className="btn btn-primary btn-sm" disabled={saving || !form.name.trim() || !form.email.trim()} onClick={save}>
          {saving ? <span className="spin" /> : 'Save contact details'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => {
          setEditing(false)
          setForm({
            name: name || '', companyName: companyName || '', email: email || '', phone: phone || '',
            ccEmails: (ccEmails || []).join(', '), paymentTermsNote: paymentTermsNote || '', notes: notes || '',
          })
        }}>
          Cancel
        </button>
      </div>
    </div>
  )
}
