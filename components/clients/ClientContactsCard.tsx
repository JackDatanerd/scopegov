// components/clients/ClientContactsCard.tsx
//
// FEATURE (deep audit, section 14, finding #8): the missing UI for
// public.client_contacts — see app/api/clients/[id]/contacts/route.ts for
// the full context. Distinct from ClientContactCard (the client's own
// single email/phone/cc_emails, used for document delivery): this is
// named people at the client — "Jane is the primary contact for scope
// questions, invoices go to Priya in billing" — that this codebase's
// schema was built to hold on day one but never surfaced.
//
// FIX (deep audit, section 14 — flagship finding): for a while this was
// purely a directory — the contacts recorded here were never actually
// consulted anywhere a document went out, which is what the comment above
// was written to eventually solve. lib/utils/client-contacts.ts now CCs
// whichever contact is marked primary on every invoice/SOW/CO send, so
// "make primary" is a real routing decision, not just a label.
//
// FEATURE (independent pass, section 14): role-based routing is built. The free-text `role` label
// still routes nothing (nobody can guess what "AP" or "Accounts Payable" means), but each contact now
// also has a structured "Receives" setting — Billing / Scope & approvals / Everything else — chosen
// from a dropdown. Billing contacts are CC'd on invoices; Scope & approvals contacts on SOWs and
// change orders.

'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Contact {
  id: string
  name: string
  email: string
  role: string | null
  role_type?: 'billing' | 'scope' | 'approver' | 'other' | null
  is_primary: boolean
}

const ROLE_TYPE_LABEL: Record<string, string> = { billing: 'Billing', scope: 'Scope', approver: 'Approver', other: 'Other' }

export default function ClientContactsCard({
  clientId, contacts, editable,
}: { clientId: string; contacts: Contact[]; editable: boolean }) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function remove(contactId: string, contactName: string, wasPrimary: boolean) {
    // One click used to delete a contact (and possibly the CC'd primary) irreversibly.
    if (!window.confirm(`Remove ${contactName}?${wasPrimary ? ' They are the primary contact, so nobody will be CC’d by default afterwards.' : ''}`)) return
    setBusyId(contactId); setError('')
    try {
      const res  = await fetch(`/api/clients/${clientId}/contacts/${contactId}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({} as Record<string, any>))
      if (!res.ok) throw new Error(json.error || 'Failed to remove contact')
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
      const json = await res.json().catch(() => ({} as Record<string, any>))
      if (!res.ok) throw new Error(json.error || 'Failed to update contact')
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

      {contacts.length > 0 && (
        <p style={{ fontSize: 11, color: 'var(--text-4)', marginBottom: 8 }}>
          The primary contact is CC&rsquo;d on every invoice, SOW, and change order. Billing contacts are also CC&rsquo;d on invoices;
          scope and approver contacts on SOWs and change orders.
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
                {c.role_type && c.role_type !== 'other' && (
                  <span className="pill pill-blue pill-sm" title="Receives copies of this kind of document">{ROLE_TYPE_LABEL[c.role_type]}</span>
                )}
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
                <button className="btn btn-ghost btn-xs" disabled={busyId === c.id} onClick={() => remove(c.id, c.name, c.is_primary)}>
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
  const [roleType, setRoleType] = useState<string>(initial?.role_type || 'other')
  const [isPrimary, setIsPrimary] = useState(initial?.is_primary || false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [baseline] = useState(initial)

  async function save() {
    if (!name.trim() || !email.trim()) return
    // FIX (independent pass 2, section 14): an edit always sent all five fields, `isPrimary` included. If
    // someone else promoted a different contact to primary after this form opened (this contact's stale
    // `is_primary: true` still in the checkbox), saving just a corrected NAME re-asserted isPrimary:true and
    // took the primary role back from them — and the CC routing with it; the email field likewise reverted a
    // teammate's correction. An edit now sends only what this person actually changed, measured against the
    // snapshot taken when the form opened.
    let payload: Record<string, unknown> = { name, email, role, roleType, isPrimary }
    if (initial) {
      payload = {}
      if (name.trim() !== baseline?.name.trim()) payload.name = name
      if (email.trim().toLowerCase() !== baseline?.email.trim().toLowerCase()) payload.email = email
      if (role.trim() !== (baseline?.role || '').trim()) payload.role = role
      if (roleType !== (baseline?.role_type || 'other')) payload.roleType = roleType
      if (isPrimary !== !!baseline?.is_primary) payload.isPrimary = isPrimary
      if (Object.keys(payload).length === 0) { onCancel(); return }
      // FIX (deep audit, section 14 — bug): unchecking "Primary contact" on the contact that
      // currently holds it reaches the exact same end state as Remove on a primary contact — the
      // client is left with no primary contact, and nobody gets CC'd via that route from here on —
      // but Remove has always warned about that ("nobody will be CC'd by default afterwards") while
      // this path saved silently. client_contact_update only demotes OTHER contacts when a patch sets
      // is_primary TRUE; it never auto-promotes a replacement when the sole primary is explicitly
      // unset, so this needs the same warning Remove already gives, not a silent save.
      if (payload.isPrimary === false && baseline?.is_primary) {
        if (!window.confirm(`Remove ${baseline.name} as the primary contact? Nobody will be CC’d by default afterwards unless you make another contact primary.`)) {
          return
        }
      }
    }
    setSaving(true); setError('')
    try {
      const res  = await fetch(
        initial ? `/api/clients/${clientId}/contacts/${initial.id}` : `/api/clients/${clientId}/contacts`,
        {
          method: initial ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      )
      const json = await res.json().catch(() => ({} as Record<string, any>))
      if (!res.ok) throw new Error(json.error || 'Failed to save contact')
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
        <label className="flbl">Receives copies of</label>
        <select className="finp" value={roleType} onChange={e => setRoleType(e.target.value)}>
          <option value="other">Nothing extra (directory only)</option>
          <option value="billing">Invoices (billing contact)</option>
          <option value="scope">SOWs &amp; change orders (scope contact)</option>
          <option value="approver">SOWs &amp; change orders (approver)</option>
        </select>
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
