'use client'
import { useState, useEffect, useRef } from 'react'
import RichTextField from '@/components/ui/RichTextField'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/utils/format'
import { nanoid } from 'nanoid'

// `kind: 'adjustment'` marks a system-written negotiation line ("Negotiated discount…") from an accepted
// counter-offer: it may be negative, and its quantity is fixed at 1.
interface LineItem { id: string; description: string; quantity: number; rate: number; total: number; kind?: 'adjustment' }

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
  const [saveStatus,   setSaveStatus]   = useState<'idle'|'saving'|'saved'|'error'>('idle')
  const [title,        setTitle]        = useState('')
  const [note,         setNote]         = useState('')
  const [lineItems,    setLineItems]    = useState<LineItem[]>([{ id: nanoid(), description: '', quantity: 1, rate: 0, total: 0 }])
  const [taxRate,      setTaxRate]      = useState('0')
  const [taxInclusive, setTaxInclusive] = useState(false)
  const [currency,     setCurrency]     = useState('USD')
  const [status,       setStatus]       = useState('draft')
  // Set when this draft is sitting in an approval chain: it is still status 'draft' in the database, but
  // the server refuses edits and a second send until the request is decided or cancelled.
  const [pendingApproval, setPendingApproval] = useState(false)
  // FIX (section-10 audit): GET /api/co/[id] now redacts line items/
  // subtotal/tax/total for a viewer without VIEW_FINANCIALS instead of
  // shipping them unconditionally. Without this, the redacted (null →
  // zeroed) values would render as an ordinary, apparently-editable $0
  // change order — indistinguishable from a real one and silently
  // discarding the fact that money is being hidden, not that there isn't
  // any. Defaults false: a brand-new CO (no coId, nothing fetched yet)
  // has nothing to redact and is never in this state.
  const [financialsHidden, setFinancialsHidden] = useState(false)
  const [saveError,   setSaveError]    = useState('')
  const [isRetainerRenewal, setIsRetainerRenewal] = useState(false)
  const [renewalTermMonths, setRenewalTermMonths] = useState('')
  // FIX (doc-quality audit round 3, migration 018): optional Impact
  // Analysis fields — timelineImpactDays as a signed string so the input
  // can hold '-5' mid-typing without parseInt fighting the user, cast to
  // int (or null) only at save time; scopeImpactNote is free text.
  const [timelineImpactDays, setTimelineImpactDays] = useState('')
  const [scopeImpactNote,    setScopeImpactNote]    = useState('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedCoId = useRef<string | null>(coId || null)
  const [aiOpen,     setAiOpen]     = useState(false)
  const [aiText,     setAiText]     = useState('')
  const [aiDrafting, setAiDrafting] = useState(false)
  const [aiError,    setAiError]    = useState('')
  // FIX: COs created via a Guardian flag's "Draft CO" action land here with
  // flag_id set but nothing in the AI box — the user had to retype the
  // client's request from the flag card. flagRequestText carries the
  // original client wording (guardian_checks.content, joined server-side)
  // so opening the AI panel can pre-fill it instead.
  const [flagId,          setFlagId]          = useState<string | null>(null)
  const [flagRequestText, setFlagRequestText] = useState<string | null>(null)

  // Derived totals
  // FIX (section-10 audit, 10-B3): the editor mirrored the server's old,
  // wrong tax-inclusive arithmetic — taxAmt forced to 0 and subtotal left
  // as the gross, so the summary showed a VAT rate with no VAT amount and
  // Subtotal identical to Total. Back-solve the net the same way
  // lib/documents/co-totals.ts now does, so what the agency sees here is
  // exactly what gets stored and printed.
  const lineSum  = lineItems.reduce((s, l) => s + (l.quantity * l.rate), 0)
  const rate     = parseFloat(taxRate) || 0
  const subtotal = taxInclusive && rate > 0 ? lineSum / (1 + rate / 100) : lineSum
  const total    = taxInclusive ? lineSum : lineSum * (1 + rate / 100)
  const taxAmt   = total - subtotal

  useEffect(() => {
    if (!coId) {
      // Fetch project currency for new CO
      fetch(`/api/projects/${projId}`)
        .then(r => r.json())
        .then(json => { if (json.project?.currency) setCurrency(json.project.currency) })
        .catch(() => {})
      // Workspace billing defaults (Settings → Workspace → Billing defaults) pre-fill a new CO's tax
      // terms. Only applied while the rate is still untouched, and only when a rate is configured.
      fetch('/api/workspace/billing-defaults')
        .then(r => r.ok ? r.json() : null)
        .then(json => {
          if (json && Number(json.taxRate) > 0) {
            setTaxRate(prev => (prev === '0' ? String(json.taxRate) : prev))
            setTaxInclusive(!!json.taxInclusive)
          }
        })
        .catch(() => {})
      return
    }
    fetch(`/api/co/${coId}`)
      .then(async r => {
        const json = await r.json()
        // FIX (regression follow-up): this used to ignore r.ok entirely
        // and just check `if (json.co)` — any failed fetch (403, 404,
        // 500, or the ambiguous-embed 500 that motivated this fix)
        // rendered as a silent, untouched blank form. No error, no sign
        // anything had gone wrong — indistinguishable from a fresh CO.
        // Surface it instead.
        if (!r.ok) { setError(json.error || 'Failed to load this change order.'); return }
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
          setPendingApproval(!!json.pendingApproval)
          setFinancialsHidden(json.permissions?.canViewFinancials === false)
          setIsRetainerRenewal(co.is_retainer_renewal || false)
          setRenewalTermMonths(co.renewal_term_months != null ? String(co.renewal_term_months) : '')
          setTimelineImpactDays(co.timeline_impact_days != null ? String(co.timeline_impact_days) : '')
          setScopeImpactNote(co.scope_impact_note || '')
          setFlagId(co.flag_id || null)
          setFlagRequestText(co.flagRequestText || null)
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

  // FIX (section-10 audit, 10-G6): SowEditor got a beforeunload guard for
  // exactly this 1.5s-debounce data-loss window; CoEditor runs the
  // identical autosave pattern and never had one, so typing and then
  // closing the tab silently discarded the last edit. Same fix, plus the
  // unmount cleanup that was also missing.
  const pendingSave = useRef(false)
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (pendingSave.current) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  // Autosave triggered by field changes when editing an existing draft
  useEffect(() => {
    if (pendingApproval) return
    // A brand-new CO has no server copy (and no autosave) until "Save draft"/"Send" — but leaving the
    // tab used to discard everything typed with no warning, because pendingSave was only ever set on the
    // autosave path below.
    if (!savedCoId.current) {
      pendingSave.current = !!(title.trim() || note.trim() || lineItems.some(l => l.description.trim() || l.rate))
      return
    }
    if (status !== 'draft') return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingSave.current = true
    setSaveStatus('saving')
    saveTimer.current = setTimeout(async () => {
      try {
        await doSave(false)
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        // FIX (section-10 audit, 10-G6): a failed autosave reset the
        // indicator to 'idle', which reads as "nothing to save" — the
        // same silent-failure shape as 9-B10. Surface it.
        setSaveStatus('error')
      } finally {
        pendingSave.current = false
      }
    }, 1500)
  }, [title, note, lineItems, taxRate, taxInclusive, isRetainerRenewal, renewalTermMonths, timelineImpactDays, scopeImpactNote])

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
        renewalTermMonths: isRetainerRenewal && renewalTermMonths.trim() !== '' ? parseInt(renewalTermMonths, 10) : null,
        timelineImpactDays: timelineImpactDays.trim() !== '' ? timelineImpactDays.trim() : null,
        scopeImpactNote:    scopeImpactNote.trim() || null,
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
        pendingSave.current = false
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
    // FIX (CO-logic fix round): matches the server-side check in
    // api/co/[id]/send/route.ts — a line item can have a nonzero rate with
    // a blank description (total !== 0 doesn't imply description !== ''),
    // which would otherwise bill the client for something unnamed. Catch
    // it here too so it's not a round-trip-only error.
    if (lineItems.some(l => l.total > 0 && !l.description.trim())) { setError('Every line item with a value needs a description'); return }
    setSending(true); setError('')
    try {
      const id = await doSave(false, false)
      if (!id) throw new Error('Failed to save CO before sending')
      const res  = await fetch(`/api/co/${id}/send`, { method: 'POST' })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json.error || 'Send failed')
      if (json.pendingApproval) alert(json.message || 'Sent for approval — this change order will go to the client once it is signed off.')
      else if (json.emailSent === false)
        alert(`The change order is marked as sent, but the email to the client could not be delivered (${json.emailError || 'provider error'}).\n\nOpen the project's Change orders tab and use "Copy link" to send it to them yourself.`)
      router.push(`/projects/${projId}?tab=co`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally { setSending(false) }
  }

  // FIX (section-10 audit): a viewer without VIEW_FINANCIALS gets the CO
  // back with its money fields nulled out (see GET /api/co/[id]) — lock
  // the editor for them too, the same way a sent/accepted CO locks. There
  // is no sensible "edit a price you can't see" state, and PATCH would
  // reject their save anyway; this just tells them why up front instead
  // of letting them type into fields backed by redacted data.
  const isLocked = status !== 'draft' || pendingApproval || financialsHidden

  async function draftWithAi() {
    if (!aiText.trim()) { setAiError('Describe what the client is asking for first.'); return }
    // The draft REPLACES the title, note and every line item. Priced rows were silently reset to 0.
    const hasWork = title.trim() || note.trim() || lineItems.some(l => l.description.trim() || l.rate > 0)
    if (hasWork && !confirm('AI drafting will replace your current title, notes and line items (rates reset to 0). Continue?')) return
    setAiDrafting(true); setAiError('')
    try {
      const res  = await fetch('/api/co/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: projId, request: aiText, flagId: flagId || undefined }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      if (json.title) setTitle(json.title)
      if (json.note)  setNote(json.note)
      if (json.scopeImpact) setScopeImpactNote(json.scopeImpact)
      if (json.timelineImpactDays != null) setTimelineImpactDays(String(json.timelineImpactDays))
      if (json.lineItems?.length) {
        setLineItems(json.lineItems.map((li: any) => ({
          id: nanoid(), description: li.description, quantity: li.quantity || 1, rate: 0, total: 0,
        })))
      }
      setAiOpen(false); setAiText('')
    } catch (err: unknown) {
      setAiError(err instanceof Error ? err.message : 'Could not draft this — try again or write it manually.')
    } finally { setAiDrafting(false) }
  }

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
            {saveStatus === 'error' && <><span title={saveError}><i className="ti ti-alert-circle" style={{ fontSize: 11, color: 'var(--red)' }} /> Save failed{saveError ? ` — ${saveError}` : ''}</span></>}
          </span>
        </div>

        {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}
        {/* FIX (section-10 audit, 10-G3 + 10-G4): this said "Withdraw it
            to edit." — but PATCH /api/co/[id] requires status 'draft', and
            withdrawing sets it to 'withdrawn', which is not draft. So
            following the instruction made the CO strictly LESS editable,
            permanently. And for a declined CO (which CoCard sent here via
            its "Negotiate" button) withdraw isn't even a permitted
            transition. Tell the truth, and point at the action that
            actually works: Revise & resend, on the project's CO tab. */}
        {isLocked && (
          <div className="banner banner-info" style={{ marginBottom: 14 }}>
            {financialsHidden
              ? <>You don&rsquo;t have permission to view this change order&rsquo;s pricing, so it&rsquo;s shown read-only. Ask an admin for financial access if you need to edit it.</>
              : pendingApproval && status === 'draft'
              ? <>This change order is waiting on an approval request and can&rsquo;t be edited. Decide or cancel the request from <strong>Approvals</strong> to unlock it.</>
              : ['declined', 'withdrawn', 'closed', 'countered', 'expired'].includes(status)
                ? <>This change order is {status} and can no longer be edited. Use <strong>Revise &amp; resend</strong> on the project&rsquo;s Change orders tab to continue from it in a new draft.</>
                : status === 'accepted'
                  ? <>This change order has been accepted and signed. It is part of the agreement and can&rsquo;t be edited.</>
                  : status === 'awaiting_countersignature'
                    ? <>The client is confirming the negotiated amount. The change order is locked until they countersign.</>
                    : <>This change order has been sent to the client and is locked while you wait on their response.</>}
          </div>
        )}

        {!isLocked && !aiOpen && (
          <button className="btn btn-ghost btn-sm" onClick={() => {
            // Pre-fill from the flag that spawned this CO, if any — but
            // only the first time; don't clobber something the user
            // already typed and closed the panel on.
            if (!aiText && flagRequestText) setAiText(flagRequestText)
            setAiOpen(true)
          }} style={{ marginBottom: 16 }}>
            <i className="ti ti-sparkles" style={{ fontSize: 12 }} /> Draft with AI
          </button>
        )}
        {!isLocked && aiOpen && (
          <div className="surface surface-p" style={{ marginBottom: 20 }}>
            <label className="flbl">Describe what the client is asking for</label>
            <textarea className="finp" style={{ minHeight: 80, resize: 'vertical', marginTop: 6 }} autoFocus
              value={aiText} placeholder="e.g. Client wants 3 extra product pages added to the site, plus a redesigned checkout flow…"
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setAiText(e.target.value)} />
            {aiError && <p className="ferr" style={{ marginTop: 6 }}>{aiError}</p>}
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
              Drafts a title, client-facing note, and line items from your description — pricing is always left at 0 for you to set.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-primary btn-sm" onClick={draftWithAi} disabled={aiDrafting}>
                {aiDrafting ? <span className="spin" /> : 'Draft'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setAiOpen(false); setAiText(''); setAiError('') }}>Cancel</button>
            </div>
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
          <RichTextField
            value={note}
            onChange={setNote}
            disabled={isLocked}
            placeholder="Brief explanation of why this work is additional scope…"
          />
        </div>

        {/* FIX (doc-quality audit round 3, migration 018): Impact Analysis
            fields — Scope and Timeline, alongside the Value impact the PDF
            already computed automatically. Both optional; a CO with
            neither set renders exactly as before. */}
        <div className="fgrp">
          <label className="flbl">Scope impact <span className="fhint">— optional, shown to client as its own line in Impact Analysis</span></label>
          <textarea className="finp" style={{ minHeight: 50, resize: 'vertical' }} disabled={isLocked}
            value={scopeImpactNote}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setScopeImpactNote(e.target.value)}
            placeholder="e.g. NorthPoints API integration added as in-scope; see Appendix A-1" />
        </div>

        <div className="fgrp">
          <label className="flbl">Timeline impact <span className="fhint">— optional, net day shift this CO introduces</span></label>
          <input className="finp" type="number" step="1" style={{ maxWidth: 160 }} disabled={isLocked}
            value={timelineImpactDays}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTimelineImpactDays(e.target.value)}
            placeholder="e.g. 18 or -5" />
        </div>

        {/* Line items */}
        {financialsHidden ? (
          // FIX (section-10 audit): the redacted GET response resolves
          // every money field to 0/empty (see updateLineItem's default
          // row) — rendering the normal table here would show a real
          // change order as a priced-at-nothing one, which is worse than
          // just saying the pricing is hidden.
          <div className="surface surface-p" style={{ marginBottom: 14, color: 'var(--text-3)', fontSize: 13 }}>
            <i className="ti ti-lock" style={{ fontSize: 12, marginRight: 6 }} />
            Line items, tax and totals are hidden — you don&rsquo;t have financial access.
          </div>
        ) : (
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
                value={item.quantity} min={1} disabled={isLocked || item.kind === 'adjustment'}
                // FIX (section-10 audit, 10-B9): `min` is a browser hint
                // only and `parseFloat(v) || 1` let a typed negative
                // straight through to a negative line total. The API
                // rejects these now; clamp here too so the user sees it
                // immediately rather than at save time.
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'quantity', Math.max(0, parseFloat(e.target.value) || 0))} />
              <input type="number" className="finp" style={{ width: 100, fontSize: 12, textAlign: 'right' }}
                value={item.rate} min={item.kind === 'adjustment' ? undefined : 0} step="0.01" disabled={isLocked}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const v = parseFloat(e.target.value) || 0
                  // Only a system-written negotiation line may go negative.
                  updateLineItem(item.id, 'rate', item.kind === 'adjustment' ? v : Math.max(0, v))
                }} />
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
            {rate > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', color: 'var(--text-2)' }}>
                <span>Tax ({taxRate}%){taxInclusive ? ' — included' : ''}</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrency(taxAmt, currency)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 600, padding: '8px 0', borderTop: '1px solid var(--border)', marginTop: 6 }}>
              <span>Total</span>
              <span style={{ color: 'var(--green)', fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrency(total, currency)}</span>
            </div>
          </div>
        </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-2)', marginBottom: 20 }}>
          <input type="checkbox" checked={isRetainerRenewal} disabled={isLocked}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIsRetainerRenewal(e.target.checked)}
            style={{ accentColor: 'var(--green)' }} />
          This is a retainer renewal
        </label>
        {isRetainerRenewal && (
          <div className="fgrp" style={{ marginTop: -8, marginBottom: 20 }}>
            <label className="flbl">Extends the retainer by <span className="fhint">— months, counted from the current end date</span></label>
            <input type="number" className="finp" style={{ maxWidth: 160 }} min={1} max={120} step={1}
              value={renewalTermMonths} disabled={isLocked}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRenewalTermMonths(e.target.value)} placeholder="e.g. 12" />
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>
              Required to send. Without it the new rate would apply but monthly billing would still stop on the original end date.
            </p>
          </div>
        )}

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
          {financialsHidden ? (
            <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 4 }}>
              <i className="ti ti-lock" style={{ fontSize: 12, marginRight: 6 }} />Hidden — no financial access
            </div>
          ) : (
            <>
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
            </>
          )}
          {savedCoId.current && !financialsHidden && (
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
