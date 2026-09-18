// components/clients/ClientContactsCard.tsx
//
// FEATURE (deep audit, section 14, finding #8): the missing UI for
// public.client_contacts — see app/api/clients/[id]/contacts/route.ts for
// the full context. Distinct from ClientContactCard (the client's own
// single email/phone/cc_emails, used for document delivery): this is
// named people at the client — "Jane is the primary contact for scope
// questions, invoices go to Priya in billing" — that this codebase's
// schema was built to hold on day one but never surfaced.

'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Contact {
  id: string
  name: string
  email: string
  role: string | null
  is_primary: boolean
}

export default function ClientContactsCard({
  clientId, contacts, editable,
}: { clientId: string; contacts: Contact[]; editable: boolean }) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function remove(contactId: string) {
    setBusyId(contactId); setError('')
    try {
      const res  = await fetch(`/api/clients/${clientId}/contacts/${contactId}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error)
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to remove contact')
    } finally { setBusyId(null) }
  }

  async function makePrimary(contactId: string) {
    setBusyId(contactId); setError('')
    try {
      const res  = await fetch(`/api/clients/${clientId}/contacts/${contactId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPrimary: true }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error)
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update contact')
    } finally { setBusyId(null) }
  }

  return (
    <div className="surface surface-p" style={{ marginBottom: 16 }}>
      <div className="sec-hd" style={{ marginBottom: 10 }}>
        <div className="sec-title">Contacts</div>
        {editable && !adding && (
          <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
            <i className="ti ti-plus" style={{ fontSize: 12 }} /> Add
          </button>
        )}
      </div>
      {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}

      {contacts.length === 0 && !adding && (
        <p style={{ fontSize: 12, color: 'var(--text-4)', fontStyle: 'italic' }}>
          No named contacts yet — the client&rsquo;s own email above is used for documents.
        </p>
      )}

      {contacts.map(c => (
        editingId === c.id ? (
          <ContactForm
            key={c.id}
            clientId={clientId}
            initial={c}
            onDone={() => { setEditingId(null); router.refresh() }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={c.id} className="settings-row" style={{ alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                {c.name}
                {c.is_primary && <span className="pill pill-green pill-sm">Primary</span>}
                {c.role && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· {c.role}</span>}
              </div>
              <a href={`mailto:${c.email}`} style={{ fontSize: 12, color: 'var(--green)' }}>{c.email}</a>
            </div>
            {editable && (
              <div style={{ display: 'flex', gap: 4 }}>
                {!c.is_primary && (
                  <button className="btn btn-ghost btn-xs" disabled={busyId === c.id} onClick={() => makePrimary(c.id)}>
                    Make primary
                  </button>
                )}
                <button className="btn btn-ghost btn-xs" disabled={busyId === c.id} onClick={() => setEditingId(c.id)}>Edit</button>
                <button className="btn btn-ghost btn-xs" disabled={busyId === c.id} onClick={() => remove(c.id)}>
                  {busyId === c.id ? <span className="spin" /> : 'Remove'}
                </button>
              </div>
            )}
          </div>
        )
      ))}

      {adding && (
        <ContactForm
          clientId={clientId}
          onDone={() => { setAdding(false); router.refresh() }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  )
}

function ContactForm({ clientId, initial, onDone, onCancel }: {
  clientId: string; initial?: Contact; onDone: () => void; onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [email, setEmail] = useState(initial?.email || '')
  const [role, setRole] = useState(initial?.role || '')
  const [isPrimary, setIsPrimary] = useState(initial?.is_primary || false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    if (!name.trim() || !email.trim()) return
    setSaving(true); setError('')
    try {
      const res  = await fetch(
        initial ? `/api/clients/${clientId}/contacts/${initial.id}` : `/api/clients/${clientId}/contacts`,
        {
          method: initial ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, role, isPrimary }),
        }
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      onDone()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save contact')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ padding: '10px 0', borderTop: '1px solid var(--border)', marginTop: 6 }}>
      {error && <p className="ferr" style={{ marginBottom: 6 }}>{error}</p>}
      <div className="f2">
        <div className="fgrp">
          <label className="flbl">Name</label>
          <input className="finp" value={name} autoFocus onChange={e => setName(e.target.value)} placeholder="Jane Mwangi" />
        </div>
        <div className="fgrp">
          <label className="flbl">Role <span className="fhint">— optional</span></label>
          <input className="finp" value={role} onChange={e => setRole(e.target.value)} placeholder="Billing contact" />
        </div>
      </div>
      <div className="fgrp">
        <label className="flbl">Email</label>
        <input type="email" className="finp" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@acme.com" />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)', marginBottom: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={isPrimary} onChange={e => setIsPrimary(e.target.checked)} />
        Primary contact
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary btn-xs" disabled={saving || !name.trim() || !email.trim()} onClick={save}>
          {saving ? <span className="spin" /> : initial ? 'Save' : 'Add contact'}
        </button>
        <button className="btn btn-ghost btn-xs" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  )
}
