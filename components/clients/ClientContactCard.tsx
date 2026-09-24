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
import { useEffect, useMemo, useState } from 'react'
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
  // FEATURE (independent pass, section 14): clients.timezone had an API field but no UI and no reader.
  // Now editable here and shown; email_bounced_at surfaces the Resend webhook's bounce/complaint signal.
  timezone?: string | null
  emailBouncedAt?: string | null
  emailBounceKind?: string | null
  editable: boolean
}

export default function ClientContactCard({
  clientId, name, companyName, email, phone, ccEmails, paymentTermsNote, notes, timezone, emailBouncedAt, emailBounceKind, editable,
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
    timezone: timezone || '',
  })

  // The form was initialised from props once and never re-synced, so after another teammate's edit
  // (or a router.refresh) the next Edit opened with stale values and would overwrite the newer data.
  useEffect(() => {
    if (editing) return
    setForm({
      name: name || '', companyName: companyName || '', email: email || '', phone: phone || '',
      ccEmails: (ccEmails || []).join(', '), paymentTermsNote: paymentTermsNote || '', notes: notes || '',
      timezone: timezone || '',
    })
  }, [editing, name, companyName, email, phone, ccEmails, paymentTermsNote, notes, timezone])

  const zones = useMemo<string[]>(() => {
    try { return typeof (Intl as any).supportedValuesOf === 'function' ? (Intl as any).supportedValuesOf('timeZone') : [] }
    catch { return [] }
  }, [])

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
          notes: form.notes, timezone: form.timezone,
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
        {emailBouncedAt && (
          <div className="auth-error" style={{ margin: '8px 0', fontSize: 12 }}>
            <i className="ti ti-mail-exclamation" style={{ fontSize: 13, marginRight: 5 }} />
            Email to this address {emailBounceKind === 'complaint' ? 'was marked as spam' : 'bounced'} on {new Date(emailBouncedAt).toISOString().slice(0, 10)} — the client may not be receiving documents. Check the address{editable ? ' and correct it below' : ''}.
          </div>
        )}
        {phone && (
          <div className="settings-row">
            <span className="settings-row-key" style={{ fontSize: 12 }}>Phone</span>
            <span className="settings-row-val">{phone}</span>
          </div>
        )}
        {timezone && (
          <div className="settings-row">
            <span className="settings-row-key" style={{ fontSize: 12 }}>Timezone</span>
            <span className="settings-row-val">{timezone}</span>
          </div>
        )}
        {ccEmails && ccEmails.length > 0 && (
          <div className="settings-row">
            <span className="settings-row-key" style={{ fontSize: 12 }}>CC</span>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{ccEmails.join(', ')}</div>
          </div>
        )}
        {paymentTermsNote && (
          <div className="settings-row" style={notes ? undefined : { paddingBottom: 0, borderBottom: 'none' }}>
            <span className="settings-row-key" style={{ fontSize: 12 }}>Payment terms</span>
            <span className="settings-row-val" style={{ fontSize: 11 }}>{paymentTermsNote}</span>
          </div>
        )}
        {/* FIX (deep audit, section 14 — bug): `notes` was collected in the
            edit form and passed into this component, but the read-only view
            never rendered it anywhere — the only way to ever see a saved
            note was to click Edit and scroll to the textarea. That also made
            notes permanently invisible to anyone with VIEW_CLIENT_DATA but
            not editable (no Edit button to reveal them through). */}
        {notes && (
          <div className="settings-row" style={{ paddingBottom: 0, borderBottom: 'none', alignItems: 'flex-start' }}>
            <span className="settings-row-key" style={{ fontSize: 12 }}>Internal notes</span>
            <span className="settings-row-val" style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{notes}</span>
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
        <label className="flbl">CC on emails <span className="fhint">— optional, comma-separated, up to 10</span></label>
        <input className="finp" value={form.ccEmails} onChange={e => set('ccEmails', e.target.value)}
          placeholder="finance@acme.com, legal@acme.com" />
      </div>
      <div className="fgrp">
        <label className="flbl">Timezone <span className="fhint">— optional, e.g. Africa/Nairobi</span></label>
        <input className="finp" list="client-timezones" value={form.timezone} onChange={e => set('timezone', e.target.value)}
          placeholder="Africa/Nairobi" />
        {zones.length > 0 && <datalist id="client-timezones">{zones.map(z => <option key={z} value={z} />)}</datalist>}
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
            timezone: timezone || '',
          })
          setError('')
        }}>
          Cancel
        </button>
      </div>
    </div>
  )
}
