// components/clients/BillingDetailsCard.tsx
//
// Phase 11: billing_address (jsonb) and vat_number (text) have existed on
// `clients` since 001_initial_schema.sql, but nothing in the app could ever
// write them — no field on the create form, no PATCH route, no edit UI.
// That meant every invoice/SOW/CO PDF could only ever print a bare client
// name, never a real "Bill To" address, which is the single most common
// reason an AP department bounces an invoice back unpaid.
//
// This card is the missing edit surface. It lives on the client detail
// page (a Server Component) as a small client island — everything else on
// that page stays server-rendered.

'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface BillingAddress {
  line1?: string
  line2?: string
  city?: string
  region?: string
  postalCode?: string
  country?: string
}

interface Props {
  clientId: string
  vatNumber: string | null
  billingAddress: BillingAddress | null
  editable: boolean
}

function formatAddress(a: BillingAddress | null): string[] {
  if (!a) return []
  const line2 = [a.city, a.region, a.postalCode].filter(Boolean).join(', ')
  return [a.line1, a.line2, line2, a.country].filter((l): l is string => !!l && l.trim().length > 0)
}

export default function BillingDetailsCard({ clientId, vatNumber, billingAddress, editable }: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const [form, setForm] = useState<BillingAddress>(billingAddress || {})
  const [vat,  setVat]  = useState(vatNumber || '')

  // Re-sync from props when not editing (another teammate's edit / router.refresh) — the form was
  // initialised once and the next Edit would otherwise overwrite newer data with stale values.
  useEffect(() => {
    if (editing) return
    setForm(billingAddress || {})
    setVat(vatNumber || '')
  }, [editing, billingAddress, vatNumber])

  const addressLines = formatAddress(billingAddress)
  const hasAddress = addressLines.length > 0

  function set<K extends keyof BillingAddress>(key: K, value: string) {
    setForm(f => ({ ...f, [key]: value }))
  }

  async function save() {
    setSaving(true); setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billingAddress: form, vatNumber: vat }),
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
        <div className="sec-hd" style={{ marginBottom: hasAddress || vatNumber ? 10 : 4 }}>
          <div className="sec-title">Billing details</div>
          {editable && (
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
              {hasAddress ? 'Edit' : 'Add'}
            </button>
          )}
        </div>
        {hasAddress ? (
          <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>
            {addressLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        ) : (
          <p style={{ fontSize: 12.5, color: 'var(--text-3)', fontStyle: 'italic', margin: 0 }}>
            No billing address on file — invoices for this client will omit the Bill To address.
          </p>
        )}
        {vatNumber && (
          <div className="settings-row" style={{ marginTop: 10, paddingBottom: 0, borderBottom: 'none' }}>
            <span className="settings-row-key" style={{ fontSize: 12 }}>VAT / Tax ID</span>
            <span className="settings-row-val">{vatNumber}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="surface surface-p" style={{ marginBottom: 16 }}>
      <div className="sec-hd" style={{ marginBottom: 10 }}>
        <div className="sec-title">Billing details</div>
      </div>
      {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}
      <div className="fgrp">
        <label className="flbl">Address line 1</label>
        <input className="finp" value={form.line1 || ''} onChange={e => set('line1', e.target.value)} placeholder="88 Commerce Plaza, 6th Floor" />
      </div>
      <div className="fgrp">
        <label className="flbl">Address line 2 <span className="fhint">— optional</span></label>
        <input className="finp" value={form.line2 || ''} onChange={e => set('line2', e.target.value)} placeholder="Suite / department" />
      </div>
      <div className="f2">
        <div className="fgrp">
          <label className="flbl">City</label>
          <input className="finp" value={form.city || ''} onChange={e => set('city', e.target.value)} placeholder="Columbus" />
        </div>
        <div className="fgrp">
          <label className="flbl">Region / State</label>
          <input className="finp" value={form.region || ''} onChange={e => set('region', e.target.value)} placeholder="OH" />
        </div>
      </div>
      <div className="f2">
        <div className="fgrp">
          <label className="flbl">Postal code</label>
          <input className="finp" value={form.postalCode || ''} onChange={e => set('postalCode', e.target.value)} placeholder="43215" />
        </div>
        <div className="fgrp">
          <label className="flbl">Country</label>
          <input className="finp" value={form.country || ''} onChange={e => set('country', e.target.value)} placeholder="United States" />
        </div>
      </div>
      <div className="fgrp">
        <label className="flbl">VAT / Tax ID <span className="fhint">— optional</span></label>
        <input className="finp" value={vat} onChange={e => setVat(e.target.value)} placeholder="87-1046203" />
      </div>
      <div className="modal-footer" style={{ justifyContent: 'flex-start', gap: 8, paddingLeft: 0 }}>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
          {saving ? <span className="spin" /> : 'Save billing details'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setForm(billingAddress || {}); setVat(vatNumber || '') }}>
          Cancel
        </button>
      </div>
    </div>
  )
}
