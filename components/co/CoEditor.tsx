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
  // CO-4: the CO could not be loaded (non-OK response, network error, unreadable body). Without this the editor
  // stayed in its default "editable blank draft" state with autosave armed: typing a title made the next
  // autosave PATCH the REAL change order with the blank stub line items. A failed load must be a locked,
  // non-saving state, not a blank form.
  const [loadFailed, setLoadFailed] = useState(false)
  // CO-2: a NEW change order started by a member without VIEW_FINANCIALS. POST /api/co refuses any priced line or credit
  // from them (they may only start an unpriced shell), so the pricing controls are locked up front instead of letting
  // them type prices that are rejected at Save/Send. Unlike `financialsHidden` (an existing CO whose money is redacted)
  // the rest of the form stays editable.
  const [pricingLocked, setPricingLocked] = useState(false)
  const [saveError,   setSaveError]    = useState('')
  // The server refuses edits without CREATE_CHANGE_ORDERS and sends without SEND_CHANGE_ORDERS. The editor used to
  // ignore both (GET /api/co/[id] returned canEdit and nothing read it), offering a fully editable form and a Send
  // button that could only fail — for a new CO, only after the draft had already been created.
  const [canEdit, setCanEdit] = useState(true)
  const [canSend, setCanSend] = useState(true)
  const [isRetainerRenewal, setIsRetainerRenewal] = useState(false)
  // Credit / descope change order (migration 100): the agency enters positive amounts; the server stores them as a
  // reduction and the client is asked to accept a credit. Mutually exclusive with a retainer renewal.
  const [isCredit, setIsCredit] = useState(false)
  // The renewal controls only apply to a retainer, and a term is only asked for when the retainer has a fixed end to
  // extend (an open-ended one has nothing to extend).
  const [projectType, setProjectType] = useState<string | null>(null)
  const [retainerOpenEnded, setRetainerOpenEnded] = useState(false)
  // How long the client's response link stays valid (server default 30, max 90).
  const [expiresInDays, setExpiresInDays] = useState('30')
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
  // Mirrors lib/documents/co-totals.ts exactly (round the inputs, derive the line total from the rounded values, round
  // the sums) so the figures shown here are the figures that get stored and printed, not a near miss.
  const rq       = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
  const lineSum  = rq(lineItems.reduce((s, l) => s + rq(rq(l.quantity) * rq(l.rate)), 0))
  const rate     = parseFloat(taxRate) || 0
  const subtotal = taxInclusive && rate > 0 ? rq(lineSum / (1 + rate / 100)) : lineSum
  const total    = taxInclusive ? lineSum : rq(lineSum * (1 + rate / 100))
  const taxAmt   = rq(total - subtotal)
  // A credit is entered as positive amounts and shown as the reduction it is.
  const money    = (n: number) => formatCurrency(isCredit ? -n : n, currency)

  useEffect(() => {
    if (!coId) {
      // Fetch project currency for new CO
      fetch(`/api/projects/${projId}`)
        .then(r => r.json())
        .then(json => {
          if (json.project?.currency) setCurrency(json.project.currency)
          setProjectType(json.project?.type ?? null)
          setRetainerOpenEnded(json.project?.type === 'retainer' && !(Number(json.project?.retainer_duration_months) > 0))
          if (json.canViewFinancials === false) setPricingLocked(true)
          if (json.canCreateChangeOrders === false) setCanEdit(false)
          if (json.canSendChangeOrders === false) setCanSend(false)
        })
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
        if (!r.ok) { setLoadFailed(true); setError(json.error || 'Failed to load this change order.'); return }
        if (json.co) {
          const co = json.co
          setTitle(co.title || '')
          setNote(co.note || '')
          const rawItems = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])
          // A stored credit carries negative rates/totals; the editor works in the positive amounts the agency typed.
          const items = co.is_credit
            ? rawItems.map((l: any) => ({ ...l, rate: Math.abs(Number(l.rate) || 0), total: Math.abs(Number(l.total) || 0) }))
            : rawItems
          setLineItems(items.length ? items : [{ id: nanoid(), description: '', quantity: 1, rate: 0, total: 0 }])
          setIsCredit(!!co.is_credit)
          setProjectType(co.projectType ?? null)
          setRetainerOpenEnded(!!co.retainerOpenEnded)
          awaitingBaseline.current = true
          setTaxRate(String(co.tax_rate || 0))
          setTaxInclusive(co.tax_inclusive || false)
          setCurrency(co.currency || 'USD')
          setStatus(co.status || 'draft')
          setPendingApproval(!!json.pendingApproval)
          setFinancialsHidden(json.permissions?.canViewFinancials === false)
          setCanEdit(json.permissions?.canEdit !== false)
          setCanSend(json.permissions?.canSend !== false)
          setIsRetainerRenewal(co.is_retainer_renewal || false)
          setRenewalTermMonths(co.renewal_term_months != null ? String(co.renewal_term_months) : '')
          setTimelineImpactDays(co.timeline_impact_days != null ? String(co.timeline_impact_days) : '')
          setScopeImpactNote(co.scope_impact_note || '')
          setFlagId(co.flag_id || null)
          setFlagRequestText(co.flagRequestText || null)
        }
      })
      .catch(() => { setLoadFailed(true); setError('Could not load this change order — check your connection and reload the page.') })
      .finally(() => setLoading(false))
  }, [coId, projId])

  function updateLineItem(id: string, field: keyof LineItem, value: string | number) {
    setLineItems(prev => prev.map(l => {
      if (l.id !== id) return l
      const updated = { ...l, [field]: value }
      updated.total = rq(rq(updated.quantity) * rq(updated.rate))
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
  // What the server last saw. The autosave effect used to fire on the very state a load had just populated (and,
  // for a locked or hidden-financials CO, on state it must never write): opening any non-draft CO flashed "Save
  // failed — Only draft COs can be edited", and an untouched draft got a pointless PATCH that bumped updated_at.
  // Comparing against the last-saved snapshot means only a real edit schedules a save.
  const lastSaved = useRef<string | null>(null)
  const awaitingBaseline = useRef(false)
  // A create in flight — a second doSave (Save draft then Send in quick succession) awaits it and then PATCHes,
  // instead of racing a second POST that would create a duplicate change order.
  const createInFlight = useRef<Promise<string> | null>(null)
  const snapshot = JSON.stringify([title, note, lineItems, taxRate, taxInclusive, isCredit, isRetainerRenewal, renewalTermMonths, timelineImpactDays, scopeImpactNote])
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
  //
  // FIX (deep audit round 2, CO logic — flagship finding): this had no
  // `financialsHidden` guard. GET /api/co/[id] redacts line_items/
  // subtotal/tax_rate/tax_inclusive/total to null for a viewer who has
  // CREATE_CHANGE_ORDERS but not VIEW_FINANCIALS (a real, constructible
  // custom-role combination — see that route's own comment). The load
  // effect above then falls back to the "new CO" default: a single blank
  // $0 stub line, since co.line_items came back null. Every dependency in
  // this effect's array gets set by that very load, so simply OPENING a
  // draft CO you can't see the pricing of scheduled this debounce and
  // fired an unconditional PATCH ~1.5s later — overwriting the CO's real
  // line items/subtotal/total with the blank stub, permanently, before
  // the user ever touched a field. `isLocked` disables the inputs but
  // never gated this effect. There is no sensible autosave for a view the
  // user isn't even allowed to see the true values of, so skip it
  // entirely while financials are hidden — matches PATCH being pointless
  // (and, until this fix, actively destructive) in that state.
  useEffect(() => {
    if (loading) return
    // Never write (and never leave a timer armed) for a CO the server would refuse to edit or that the viewer can't
    // see the pricing of. Clearing matters: the timer used to survive these early returns.
    if (loadFailed || pendingApproval || financialsHidden || !canEdit || (savedCoId.current && status !== 'draft')) {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
      pendingSave.current = false
      if (awaitingBaseline.current) { awaitingBaseline.current = false }
      return
    }
    // First run after a load: what is on screen IS what the server has.
    if (awaitingBaseline.current) {
      awaitingBaseline.current = false
      lastSaved.current = snapshot
      return
    }
    // A brand-new CO has no server copy (and no autosave) until "Save draft"/"Send" — but leaving the tab used to
    // discard everything typed with no warning.
    if (!savedCoId.current) {
      pendingSave.current = !!(title.trim() || note.trim() || lineItems.some(l => l.description.trim() || l.rate))
      return
    }
    if (snapshot === lastSaved.current) {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
      pendingSave.current = false
      return
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingSave.current = true
    setSaveStatus('saving')
    saveTimer.current = setTimeout(async () => {
      try {
        await doSave(false)
        setSaveStatus('saved')
        setSaveError('')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch (err: unknown) {
        // A failed autosave must not read as "nothing to save" — surface why (validation the user can fix vs an outage).
        setSaveError(err instanceof Error ? err.message : 'Save failed')
        setSaveStatus('error')
      } finally {
        pendingSave.current = false
      }
    }, 1500)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, financialsHidden, pendingApproval, status, loading, loadFailed, canEdit])

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
        isCredit,
        isRetainerRenewal,
        // Only a fixed-term retainer has a term to extend.
        renewalTermMonths: isRetainerRenewal && !retainerOpenEnded && renewalTermMonths.trim() !== '' ? parseInt(renewalTermMonths, 10) : null,
        timelineImpactDays: timelineImpactDays.trim() !== '' ? timelineImpactDays.trim() : null,
        scopeImpactNote:    scopeImpactNote.trim() || null,
      }
      // Another save is still creating this CO — wait for it, then update that row rather than creating a second.
      if (!savedCoId.current && createInFlight.current) await createInFlight.current.catch(() => {})
      if (savedCoId.current) {
        const res = await fetch(`/api/co/${savedCoId.current}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        if (!res.ok) { const j = await res.json().catch(() => ({} as any)); throw new Error(j.error || 'Save failed') }
        lastSaved.current = snapshot
        return savedCoId.current
      } else {
        const create = (async () => {
          const res  = await fetch('/api/co', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          })
          const json = await res.json().catch(() => ({} as any))
          if (!res.ok) throw new Error(json.error || 'Save failed')
          savedCoId.current = json.coId
          lastSaved.current = snapshot
          return json.coId as string
        })()
        createInFlight.current = create
        try { await create } finally { createInFlight.current = null }
        pendingSave.current = false
        if (navigate) router.replace(`/projects/${projId}/co/${savedCoId.current}`)
        return savedCoId.current
      }
    } catch (err: unknown) {
      if (explicit) setError(err instanceof Error ? err.message : 'Save failed')
      throw err
    } finally {
      if (explicit) setSaving(false)
    }
  }

  async function handleSend() {
    if (!canSend) { setError("You don't have permission to send change orders. Save the draft and ask someone who can."); return }
    if (!title.trim()) { setError('Title is required'); return }
    if (lineItems.every(l => l.total === 0)) { setError('Add at least one line item with a value'); return }
    // FIX (CO-logic fix round): matches the server-side check in
    // api/co/[id]/send/route.ts — a line item can have a nonzero rate with
    // a blank description (total !== 0 doesn't imply description !== ''),
    // which would otherwise bill the client for something unnamed. Catch
    // it here too so it's not a round-trip-only error.
    if (lineItems.some(l => l.total !== 0 && !l.description.trim())) { setError('Every line item with a value needs a description'); return }
    setSending(true); setError('')
    try {
      const id = await doSave(false, false)
      if (!id) throw new Error('Failed to save CO before sending')
      const res  = await fetch(`/api/co/${id}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays: parseInt(expiresInDays, 10) || 30 }),
      })
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
  const isLocked = status !== 'draft' || pendingApproval || financialsHidden || loadFailed || !canEdit

  async function draftWithAi() {
    if (!aiText.trim()) { setAiError('Describe what the client is asking for first.'); return }
    // The draft REPLACES the title, note and every line item. Priced rows were silently reset to 0.
    const hasWork = title.trim() || note.trim() || scopeImpactNote.trim() || timelineImpactDays.trim() || lineItems.some(l => l.description.trim() || l.rate > 0)
    if (hasWork && !confirm('AI drafting will replace your current title, notes, impact analysis and line items (rates reset to 0). Continue?')) return
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
      // The draft is a fresh reading of THIS request, so the impact fields are replaced too — when the AI can't tell
      // (null), clear them rather than leave the previous request's timeline/scope note in place, where they would
      // be sent to the client as a claim about this change order.
      setScopeImpactNote(json.scopeImpact || '')
      setTimelineImpactDays(json.timelineImpactDays != null ? String(json.timelineImpactDays) : '')
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
        {isLocked && !loadFailed && (
          <div className="banner banner-info" style={{ marginBottom: 14 }}>
            {!canEdit
              ? <>You don&rsquo;t have permission to edit change orders, so this one is shown read-only.</>
              : financialsHidden
              ? <>You don&rsquo;t have permission to view this change order&rsquo;s pricing, so it&rsquo;s shown read-only. Ask an admin for financial access if you need to edit it.</>
              : pendingApproval && status === 'draft'
              ? <>This change order is waiting on an approval request and can&rsquo;t be edited. Decide or cancel the request from <strong>Approvals</strong> to unlock it.</>
              : ['declined', 'withdrawn', 'closed', 'countered', 'expired'].includes(status)
                ? <>This change order is {status} and can no longer be edited. Use <strong>Revise &amp; resend</strong> on the project&rsquo;s Change orders tab to continue from it in a new draft.</>
                : status === 'exception_granted'
                  ? <>This change order was granted to the client as an exception, so it can no longer be edited.</>
                : status === 'accepted'
                  ? <>This change order has been accepted and signed. It is part of the agreement and can&rsquo;t be edited.</>
                  : status === 'awaiting_countersignature'
                    ? <>The client is confirming the negotiated amount. The change order is locked until they countersign.</>
                    : status === 'stalled'
                      ? <>The client hasn&rsquo;t responded yet, so this change order is locked. Use <strong>Try again</strong> on the project&rsquo;s Change orders tab to nudge them, or withdraw it there to revise.</>
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
            placeholder={isCredit ? 'Scope reduction — Social media management removed' : 'Additional scope — Social media management'} />
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
          {pricingLocked && (
            <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 10px' }}>
              <i className="ti ti-lock" style={{ fontSize: 12, marginRight: 6 }} />
              You don&rsquo;t have financial access, so you can describe the change here but someone with financial access needs to add the pricing.
            </p>
          )}
          <div style={{ display: 'flex', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.07em', color: 'var(--text-3)', paddingBottom: 8,
            borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
            <span style={{ flex: 1 }}>{isCredit ? 'Scope removed / credited' : 'Description'}</span>
            <span style={{ width: 64, textAlign: 'center' }}>Qty</span>
            <span style={{ width: 100, textAlign: 'right' }}>{isCredit ? 'Credit each' : 'Rate'}</span>
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
                value={item.rate} min={item.kind === 'adjustment' ? undefined : 0} step="0.01" disabled={isLocked || pricingLocked}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const v = parseFloat(e.target.value) || 0
                  // Only a system-written negotiation line may go negative.
                  updateLineItem(item.id, 'rate', item.kind === 'adjustment' ? v : Math.max(0, v))
                }} />
              <div style={{ width: 100, textAlign: 'right', fontSize: 13, fontFamily: 'IBM Plex Mono, monospace', color: 'var(--text-2)' }}>
                {money(item.total)}
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
              <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{money(subtotal)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)', flex: 1 }}>Tax rate (%)</span>
              <input type="number" className="finp" style={{ width: 80, fontSize: 12, padding: '4px 8px' }}
                value={taxRate} min={0} max={100} step="0.01" disabled={isLocked || pricingLocked}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTaxRate(e.target.value)} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={taxInclusive} disabled={isLocked || pricingLocked}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTaxInclusive(e.target.checked)}
                  style={{ accentColor: 'var(--green)' }} />
                Tax inclusive
              </label>
            </div>
            {rate > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', color: 'var(--text-2)' }}>
                <span>Tax ({taxRate}%){taxInclusive ? ' — included' : ''}</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{money(taxAmt)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 600, padding: '8px 0', borderTop: '1px solid var(--border)', marginTop: 6 }}>
              <span>Total</span>
              <span style={{ color: isCredit ? 'var(--red)' : 'var(--green)', fontFamily: 'IBM Plex Mono, monospace' }}>{money(total)}</span>
            </div>
          </div>
        </div>
        )}

        {/* Credit / descope: the change order reduces scope and money instead of adding it. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: isRetainerRenewal ? 'not-allowed' : 'pointer', fontSize: 13, color: 'var(--text-2)', marginBottom: 8, opacity: isRetainerRenewal ? 0.5 : 1 }}>
          <input type="checkbox" checked={isCredit} disabled={isLocked || isRetainerRenewal || pricingLocked}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const on = e.target.checked
              setIsCredit(on)
              // CO-1: a credit carries no system-written negotiation lines (the server sheds them too); drop them here
              // so the totals on screen are the ones that get saved.
              if (on) setLineItems(prev => {
                const kept = prev.filter(l => l.kind !== 'adjustment')
                return kept.length ? kept : [{ id: nanoid(), description: '', quantity: 1, rate: 0, total: 0 }]
              })
            }}
            style={{ accentColor: 'var(--green)' }} />
          This is a credit / scope reduction
        </label>
        {isCredit && (
          <p style={{ fontSize: 11, color: 'var(--text-3)', margin: '0 0 14px 24px' }}>
            List what is being removed, with the amount credited for each. On acceptance the amounts reduce the contract value and
            the items leave the scope Guardian checks requests against. A credit can be accepted or declined by the client, not countered.
          </p>
        )}
        {projectType === 'retainer' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: isCredit ? 'not-allowed' : 'pointer', fontSize: 13, color: 'var(--text-2)', marginBottom: 20, opacity: isCredit ? 0.5 : 1 }}>
            <input type="checkbox" checked={isRetainerRenewal} disabled={isLocked || isCredit}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIsRetainerRenewal(e.target.checked)}
              style={{ accentColor: 'var(--green)' }} />
            This is a retainer renewal
          </label>
        )}
        {projectType === 'retainer' && isRetainerRenewal && !retainerOpenEnded && (
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
        {projectType === 'retainer' && isRetainerRenewal && retainerOpenEnded && (
          <p style={{ fontSize: 11, color: 'var(--text-3)', margin: '-8px 0 20px 24px' }}>
            This retainer is open-ended, so there is no end date to extend — accepting this renewal just sets the new monthly rate.
          </p>
        )}

        {!isLocked && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {canSend && (
              <button className="btn btn-primary" onClick={handleSend} disabled={sending || !title.trim()}>
                {sending ? <><span className="spin" /> Sending…</> : <><i className="ti ti-send" style={{ fontSize: 13 }} /> Send to client</>}
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => doSave(true)} disabled={saving || !title.trim()}>
              {saving ? <span className="spin spin-dark" /> : 'Save draft'}
            </button>
            <button className="btn btn-ghost" onClick={() => router.push(`/projects/${projId}?tab=co`)}>Cancel</button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-3)', marginLeft: 'auto' }}>
              Link valid for
              <select className="finp" style={{ width: 'auto', fontSize: 12, padding: '4px 8px' }} value={expiresInDays}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setExpiresInDays(e.target.value)}>
                {[7, 14, 30, 60, 90].map(d => <option key={d} value={String(d)}>{d} days</option>)}
              </select>
            </label>
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
              <div style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 30, color: isCredit ? 'var(--red)' : 'var(--green)', marginBottom: 4 }}>
                {money(total)}
              </div>
              {isCredit && <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>Credit — reduces the contract</div>}
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
                {lineItems.filter(l => l.description).length} line item{lineItems.filter(l => l.description).length !== 1 ? 's' : ''}
                {parseFloat(taxRate) > 0 && ` · ${taxRate}% tax`}
              </div>
              {lineItems.filter(l => l.description).map(l => (
                <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--surface-2)', color: 'var(--text-2)' }}>
                  <span style={{ flex: 1, marginRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</span>
                  <span style={{ fontFamily: 'IBM Plex Mono, monospace', flexShrink: 0 }}>{money(l.total)}</span>
                </div>
              ))}
            </>
          )}
          <CoAttachmentsPanel coId={savedCoId.current} canEdit={!isLocked} />
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

// ── Attachments panel ────────────────────────────────────────────────────
// UI for api/co/[id]/attachments (see that route's header comment). Internal working material — not shown to the
// client. Self-contained fetch/upload/delete state, same shape as SowEditor's panel.
function CoAttachmentsPanel({ coId, canEdit }: { coId: string | null; canEdit: boolean }) {
  const [attachments, setAttachments] = useState<Array<{
    id: string; fileName: string; fileSize: number; mimeType: string
    uploadedAt: string; uploadedByName: string; downloadUrl: string | null
  }>>([])
  const [loading, setLoading] = useState(!!coId)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (!coId) { setLoading(false); return }
    setLoading(true)
    fetch(`/api/co/${coId}/attachments`)
      .then(res => res.json())
      .then(json => { if (mounted.current) setAttachments(Array.isArray(json.attachments) ? json.attachments : []) })
      .catch(() => {})
      .finally(() => { if (mounted.current) setLoading(false) })
  }, [coId])

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !coId) return
    if (file.size > 10 * 1024 * 1024) { setError('File exceeds 10 MB limit'); return }
    setError(''); setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`/api/co/${coId}/attachments`, { method: 'POST', body: formData })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) { setError(json.error || 'Upload failed'); return }
      setAttachments(prev => [json.attachment, ...prev])
    } catch {
      setError('Upload failed — check your connection and try again.')
    } finally { if (mounted.current) setUploading(false) }
  }

  async function handleDelete(id: string) {
    if (!coId) return
    setError(''); setDeletingId(id)
    const previous = attachments
    setAttachments(prev => prev.filter(a => a.id !== id))
    try {
      const res = await fetch(`/api/co/${coId}/attachments/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({} as any))
        setAttachments(previous)
        setError(json.error || 'Could not remove attachment')
      }
    } catch {
      setAttachments(previous)
      setError('Could not remove attachment — check your connection.')
    } finally { if (mounted.current) setDeletingId(null) }
  }

  if (loading) return null
  const size = (b: number) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-3)' }}>
          Attachments{attachments.length > 0 ? ` (${attachments.length})` : ''}
        </span>
        {coId && canEdit && (
          <>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFilePick}
              accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.eml,.docx" />
            <button type="button" className="btn btn-ghost btn-xs" disabled={uploading}
              onClick={() => fileInputRef.current?.click()} title="Attach a file">
              {uploading ? <span className="spin spin-dark" style={{ width: 10, height: 10 }} /> : <i className="ti ti-paperclip" style={{ fontSize: 11 }} />}
            </button>
          </>
        )}
      </div>
      {!coId && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Save the draft to attach files. Attachments are internal — the client doesn&rsquo;t see them.</div>}
      {error && <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 4 }}>{error}</div>}
      {attachments.map(a => (
        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 12 }}>
          <i className="ti ti-file" style={{ fontSize: 12, color: 'var(--text-4)', flexShrink: 0 }} />
          <a href={a.downloadUrl || undefined} target="_blank" rel="noopener noreferrer" title={`${a.fileName} — ${size(a.fileSize)}`}
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: a.downloadUrl ? 'var(--text-2)' : 'var(--text-4)', textDecoration: 'none', pointerEvents: a.downloadUrl ? 'auto' : 'none' }}>
            {a.fileName}
          </a>
          {canEdit && (
            <button type="button" className="btn-icon" disabled={deletingId === a.id} onClick={() => handleDelete(a.id)}
              title="Remove attachment" style={{ flexShrink: 0, width: 20, height: 20, color: 'var(--text-4)' }}>
              {deletingId === a.id ? <span className="spin spin-dark" style={{ width: 9, height: 9 }} /> : <i className="ti ti-x" style={{ fontSize: 10 }} />}
            </button>
          )}
        </div>
      ))}
      {coId && attachments.length === 0 && !error && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>None yet. Internal only — not shown to the client.</div>}
    </div>
  )
}
