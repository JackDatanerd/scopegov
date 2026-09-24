'use client'

import { useEffect, useState } from 'react'

// Document numbering — the prefix and next number for SOWs, change orders and invoices.
// Numbers are handed out when a document is SENT (never for drafts), so the "next number" here is
// the one the next send will use. The server refuses a number that would collide with one already
// issued under the same prefix (see set_document_sequence in migration 076).

interface Sequence { documentType: 'sow' | 'co' | 'invoice'; label: string; defaultPrefix: string; prefix: string; nextNumber: number }

const PREFIX_RE = /^[A-Z0-9]([A-Z0-9-]{0,10}[A-Z0-9])?$/

const preview = (prefix: string, next: number) =>
  `${prefix}-${String(Math.max(1, Math.floor(next) || 1)).padStart(4, '0')}`

export default function DocumentNumberingSection() {
  const [rows, setRows] = useState<Sequence[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  // Editable copies, keyed by document type.
  const [draft, setDraft] = useState<Record<string, { prefix: string; next: string }>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({})

  function load() {
    fetch('/api/workspace/numbering')
      .then(async r => {
        const json = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(json.error || 'Could not load document numbering.')
        return json
      })
      .then(json => {
        const seqs: Sequence[] = json.sequences || []
        setRows(seqs)
        setDraft(Object.fromEntries(seqs.map(s => [s.documentType, { prefix: s.prefix, next: String(s.nextNumber) }])))
      })
      .catch(err => setLoadErr(err instanceof Error ? err.message : 'Could not load document numbering.'))
  }
  useEffect(load, [])

  async function save(s: Sequence) {
    const d = draft[s.documentType]
    const prefix = d.prefix.trim().toUpperCase()
    const next = Number(d.next)
    if (!PREFIX_RE.test(prefix)) {
      setMsg(m => ({ ...m, [s.documentType]: { ok: false, text: 'Prefix can use letters, numbers and hyphens (up to 12 characters) and must start and end with a letter or number.' } }))
      return
    }
    if (!Number.isInteger(next) || next < 1 || next > 99999999) {
      setMsg(m => ({ ...m, [s.documentType]: { ok: false, text: 'Next number must be a whole number of 1 or more.' } }))
      return
    }
    setBusy(s.documentType)
    setMsg(m => ({ ...m, [s.documentType]: { ok: true, text: '' } }))
    try {
      const res = await fetch('/api/workspace/numbering', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentType: s.documentType, prefix, nextNumber: next }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Save failed')
      setRows(rs => (rs || []).map(r => r.documentType === s.documentType ? { ...r, prefix: json.prefix, nextNumber: json.nextNumber } : r))
      setDraft(dr => ({ ...dr, [s.documentType]: { prefix: json.prefix, next: String(json.nextNumber) } }))
      setMsg(m => ({ ...m, [s.documentType]: { ok: true, text: 'Saved.' } }))
      setTimeout(() => setMsg(m => ({ ...m, [s.documentType]: { ok: true, text: '' } })), 2500)
    } catch (err) {
      setMsg(m => ({ ...m, [s.documentType]: { ok: false, text: err instanceof Error ? err.message : 'Save failed' } }))
    } finally { setBusy(null) }
  }

  return (
    <div className="settings-section" style={{ marginTop: 24 }}>
      <div className="settings-section-title">
        Document numbering <span className="fhint" style={{ fontWeight: 400 }}>— moving from another tool? Carry your numbering on</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
        A document gets its number when it is sent, not while it is a draft. Set the number the <em>next</em> one should get.
        A number that has already been issued under the same prefix can&apos;t be reused.
      </p>
      {loadErr && <p className="ferr">{loadErr}</p>}
      {!rows && !loadErr && <p style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</p>}
      {rows && rows.map(s => {
        const d = draft[s.documentType] || { prefix: s.prefix, next: String(s.nextNumber) }
        const dirty = d.prefix.trim().toUpperCase() !== s.prefix || Number(d.next) !== s.nextNumber
        const m = msg[s.documentType]
        return (
          <div key={s.documentType} className="fgrp" style={{ marginBottom: 14 }}>
            <label className="flbl">{s.label}s</label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="finp" style={{ width: 130 }} value={d.prefix} maxLength={12} aria-label={`${s.label} prefix`}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setDraft(dr => ({ ...dr, [s.documentType]: { ...d, prefix: e.target.value.toUpperCase() } }))}
                placeholder={s.defaultPrefix} />
              <input className="finp" style={{ width: 130 }} type="number" min={1} value={d.next} aria-label={`${s.label} next number`}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setDraft(dr => ({ ...dr, [s.documentType]: { ...d, next: e.target.value } }))} />
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                Next: <strong>{preview(d.prefix.trim().toUpperCase() || s.defaultPrefix, Number(d.next))}</strong>
              </span>
              <button className="btn btn-primary btn-sm" disabled={busy === s.documentType || !dirty} onClick={() => save(s)}>
                {busy === s.documentType ? <span className="spin" /> : 'Save'}
              </button>
            </div>
            {m?.text && <p className={m.ok ? 'fhint' : 'ferr'} style={{ marginTop: 6 }}>{m.text}</p>}
          </div>
        )
      })}
    </div>
  )
}
