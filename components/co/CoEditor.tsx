'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/utils/format'
import { nanoid } from 'nanoid'

interface LineItem { id: string; description: string; quantity: number; rate: number; total: number }

interface Props {
  projId: string
  coId:   string | undefined
}

export default function CoEditor({ projId, coId }: Props) {
  const router = useRouter()

  const [loading,      setLoading]      = useState(!!coId)
  const [saving,       setSaving]       = useState(false)
  const [sending,      setSending]      = useState(false)
  const [error,        setError]        = useState('')
  const [saveStatus,   setSaveStatus]   = useState<'idle'|'saving'|'saved'>('idle')
  const [title,        setTitle]        = useState('')
  const [note,         setNote]         = useState('')
  const [lineItems,    setLineItems]    = useState<LineItem[]>([{ id: nanoid(), description: '', quantity: 1, rate: 0, total: 0 }])
  const [taxRate,      setTaxRate]      = useState('0')
  const [taxInclusive, setTaxInclusive] = useState(false)
  const [currency,     setCurrency]     = useState('USD')
  const [status,       setStatus]       = useState('draft')
  const [isRetainerRenewal, setIsRetainerRenewal] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedCoId = useRef<string | null>(coId || null)

  // Derived totals
  const subtotal = lineItems.reduce((s, l) => s + (l.quantity * l.rate), 0)
  const taxAmt   = taxInclusive ? 0 : subtotal * (parseFloat(taxRate) || 0) / 100
  const total    = subtotal + taxAmt

  useEffect(() => {
    if (!coId) {
      // Fetch project currency for new CO
      fetch(`/api/projects/${projId}`)
        .then(r => r.json())
        .then(json => { if (json.project?.currency) setCurrency(json.project.currency) })
        .catch(() => {})
      return
    }
    fetch(`/api/co/${coId}`)
      .then(r => r.json())
      .then(json => {
        if (json.co) {
          const co = json.co
          setTitle(co.title || '')
          setNote(co.note || '')
          const items = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])
          setLineItems(items.length ? items : [{ id: nanoid(), description: '', quantity: 1, rate: 0, total: 0 }])
          setTaxRate(String(co.tax_rate || 0))
          setTaxInclusive(co.tax_inclusive || false)
          setCurrency(co.currency || 'USD')
          setStatus(co.status || 'draft')
          setIsRetainerRenewal(co.is_retainer_renewal || false)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [coId, projId])

  function updateLineItem(id: string, field: keyof LineItem, value: string | number) {
    setLineItems(prev => prev.map(l => {
      if (l.id !== id) return l
      const updated = { ...l, [field]: value }
      updated.total = updated.quantity * updated.rate
      return updated
    }))
  }

  function addLine() {
    setLineItems(prev => [...prev, { id: nanoid(), description: '', quantity: 1, rate: 0, total: 0 }])
  }

  function removeLine(id: string) {
    if (lineItems.length === 1) return
    setLineItems(prev => prev.filter(l => l.id !== id))
  }

  // Autosave triggered by field changes when editing an existing draft
  useEffect(() => {
    if (!savedCoId.current || status !== 'draft') return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveStatus('saving')
    saveTimer.current = setTimeout(async () => {
      try {
        await doSave(false)
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('idle')
      }
    }, 1500)
  }, [title, note, lineItems, taxRate, taxInclusive, isRetainerRenewal])

  // FIX (CO send "not found" on a brand-new CO): doSave() used to always
  // call router.replace() to the new CO's own URL immediately after
  // creating it — including when it was being called from inside
  // handleSend(), which then went on to fire the /send request against a
  // component that was already mid-unmount from that navigation. Adding a
  // `navigate` flag lets handleSend create the CO without triggering that
  // navigation, so /send fires against a still-mounted, stable component,
  // and the only navigation happens once, at the very end, after send
  // actually succeeds.
  async function doSave(explicit = true, navigate = true): Promise<string | null> {
    if (explicit) { setSaving(true); setError('') }
    try {
      const body = {
        projectId: projId,
        title:     title.trim(),
        note:      note.trim() || null,
        lineItems,
        taxRate:   parseFloat(taxRate) || 0,
        taxInclusive,
        isRetainerRenewal,
      }
      if (savedCoId.current) {
        const res = await fetch(`/api/co/${savedCoId.current}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
        return savedCoId.current
      } else {
        const res  = await fetch('/api/co', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error)
        savedCoId.current = json.coId
        if (navigate) router.replace(`/projects/${projId}/co/${json.coId}`)
        return json.coId
      }
    } catch (err: unknown) {
      if (explicit) setError(err instanceof Error ? err.message : 'Save failed')
      throw err
    } finally {
      if (explicit) setSaving(false)
    }
  }

  async function handleSend() {
    if (!title.trim()) { setError('Title is required'); return }
    if (lineItems.every(l => l.total === 0)) { setError('Add at least one line item with a value'); return }
    setSending(true); setError('')
    try {
      const id = await doSave(false, false)
      if (!id) throw new Error('Failed to save CO before sending')
      const res  = await fetch(`/api/co/${id}/send`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      router.push(`/projects/${projId}?tab=co`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally { setSending(false) }
  }

  const isLocked = status !== 'draft'

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <span className="spin spin-dark" style={{ width: 24, height: 24 }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 24, padding: '28px 40px', maxWidth: 960 }}>
      {/* ── Left: editor ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <button className="btn-icon" onClick={() => router.push(`/projects/${projId}?tab=co`)}
              style={{ marginRight: 10 }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 14 }} />
            </button>
            <span style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400 }}>
              {coId ? 'Edit change order' : 'New change order'}
            </span>
          </div>
          <span className={`save-status ${saveStatus}`} style={{ fontSize: 11 }}>
            {saveStatus === 'saving' && <><span className="spin spin-dark" style={{ width: 10, height: 10 }} /> Saving</>}
            {saveStatus === 'saved' && <><i className="ti ti-check" style={{ fontSize: 11, color: 'var(--green)' }} /> Saved</>}
          </span>
        </div>

        {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}
        {isLocked && (
          <div className="banner banner-info" style={{ marginBottom: 14 }}>
            This change order has been sent and is locked. Withdraw it to edit.
          </div>
        )}

        <div className="fgrp">
          <label className="flbl">Title</label>
          <input className="finp" value={title} disabled={isLocked}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
            placeholder="Additional scope — Social media management" />
        </div>

        <div className="fgrp">
          <label className="flbl">Context note <span className="fhint">— optional, shown to client</span></label>
          <textarea className="finp" style={{ minHeight: 80, resize: 'vertical' }}
            value={note} disabled={isLocked}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
            placeholder="Brief explanation of why this work is additional scope…" />
        </div>

        {/* Line items */}
        <div className="surface surface-p" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.07em', color: 'var(--text-3)', paddingBottom: 8,
            borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
            <span style={{ flex: 1 }}>Description</span>
            <span style={{ width: 64, textAlign: 'center' }}>Qty</span>
            <span style={{ width: 100, textAlign: 'right' }}>Rate</span>
            <span style={{ width: 100, textAlign: 'right' }}>Total</span>
            <span style={{ width: 32 }} />
          </div>

          {lineItems.map((item, idx) => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <input className="finp" style={{ flex: 1, fontSize: 12 }} value={item.description}
                disabled={isLocked} placeholder={`Item ${idx + 1}`}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'description', e.target.value)} />
              <input type="number" className="finp" style={{ width: 64, fontSize: 12, textAlign: 'center' }}
                value={item.quantity} min={1} disabled={isLocked}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'quantity', parseFloat(e.target.value) || 1)} />
              <input type="number" className="finp" style={{ width: 100, fontSize: 12, textAlign: 'right' }}
                value={item.rate} min={0} step="0.01" disabled={isLocked}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'rate', parseFloat(e.target.value) || 0)} />
              <div style={{ width: 100, textAlign: 'right', fontSize: 13, fontFamily: 'IBM Plex Mono, monospace', color: 'var(--text-2)' }}>
                {formatCurrency(item.total, currency)}
              </div>
              <div style={{ width: 32, textAlign: 'right' }}>
                {!isLocked && lineItems.length > 1 && (
                  <button className="btn-icon" onClick={() => removeLine(item.id)}>
                    <i className="ti ti-x" style={{ fontSize: 12 }} />
                  </button>
                )}
              </div>
            </div>
          ))}

          {!isLocked && (
            <button className="btn btn-ghost btn-sm" onClick={addLine} style={{ marginTop: 6 }}>
              <i className="ti ti-plus" style={{ fontSize: 12 }} /> Add line item
            </button>
          )}

          {/* Totals */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', color: 'var(--text-2)' }}>
              <span>Subtotal</span>
              <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrency(subtotal, currency)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)', flex: 1 }}>Tax rate (%)</span>
              <input type="number" className="finp" style={{ width: 80, fontSize: 12, padding: '4px 8px' }}
                value={taxRate} min={0} max={100} step="0.01" disabled={isLocked}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTaxRate(e.target.value)} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={taxInclusive} disabled={isLocked}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTaxInclusive(e.target.checked)}
                  style={{ accentColor: 'var(--green)' }} />
                Tax inclusive
              </label>
            </div>
            {parseFloat(taxRate) > 0 && !taxInclusive && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', color: 'var(--text-2)' }}>
                <span>Tax ({taxRate}%)</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrency(taxAmt, currency)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 600, padding: '8px 0', borderTop: '1px solid var(--border)', marginTop: 6 }}>
              <span>Total</span>
              <span style={{ color: 'var(--green)', fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrency(total, currency)}</span>
            </div>
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-2)', marginBottom: 20 }}>
          <input type="checkbox" checked={isRetainerRenewal} disabled={isLocked}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIsRetainerRenewal(e.target.checked)}
            style={{ accentColor: 'var(--green)' }} />
          This is a retainer renewal
        </label>

        {!isLocked && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={handleSend} disabled={sending || !title.trim()}>
              {sending ? <><span className="spin" /> Sending…</> : <><i className="ti ti-send" style={{ fontSize: 13 }} /> Send to client</>}
            </button>
            <button className="btn btn-ghost" onClick={() => doSave(true)} disabled={saving || !title.trim()}>
              {saving ? <span className="spin spin-dark" /> : 'Save draft'}
            </button>
            <button className="btn btn-ghost" onClick={() => router.push(`/projects/${projId}?tab=co`)}>Cancel</button>
          </div>
        )}
      </div>

      {/* ── Right: summary card ── */}
      <div style={{ paddingTop: 50 }}>
        <div className="surface surface-p" style={{ position: 'sticky', top: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-3)', marginBottom: 12 }}>
            Summary
          </div>
          <div style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 30, color: 'var(--green)', marginBottom: 4 }}>
            {formatCurrency(total, currency)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
            {lineItems.filter(l => l.description).length} line item{lineItems.filter(l => l.description).length !== 1 ? 's' : ''}
            {parseFloat(taxRate) > 0 && ` · ${taxRate}% tax`}
          </div>
          {lineItems.filter(l => l.description).map(l => (
            <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--surface-2)', color: 'var(--text-2)' }}>
              <span style={{ flex: 1, marginRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</span>
              <span style={{ fontFamily: 'IBM Plex Mono, monospace', flexShrink: 0 }}>{formatCurrency(l.total, currency)}</span>
            </div>
          ))}
          {savedCoId.current && (
            <a href={`/api/pdf/co/${savedCoId.current}`} target="_blank"
              className="btn btn-ghost btn-sm" style={{ marginTop: 14, width: '100%', justifyContent: 'center', display: 'flex' }}>
              <i className="ti ti-download" style={{ fontSize: 12 }} /> Download PDF
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
