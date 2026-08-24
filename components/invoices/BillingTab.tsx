// components/invoices/BillingTab.tsx
//
// Phase 4a (client invoicing) + Phase 4 (contract reconciliation), scoped
// to a single project. Workspace-wide invoice list lives at /invoices
// (app/(app)/invoices/page.tsx) and links back here for any action.

'use client'
import { useState, useEffect } from 'react'
import { nanoid } from 'nanoid'
import { formatCurrency, formatDate, invoiceStatusLabel, invoicePill } from '@/lib/utils/format'
import RichTextField from '@/components/ui/RichTextField'

const METHOD_LABELS: Record<string, string> = {
  bank_transfer: 'Bank transfer', stripe: 'Stripe', check: 'Check', cash: 'Cash', other: 'Other',
}

interface Props {
  project: any
  milestones: any[]
  invoices: any[]
  reconciliation: any[]
  permissions: { viewFinancials: boolean; sendInvoices: boolean }
  currency: string
  router: any
  defaultPaymentInstructions?: string
}

export default function BillingTab({ project, milestones, invoices, reconciliation, permissions, currency, router, defaultPaymentInstructions = '' }: Props) {
  const [creating, setCreating]   = useState(false)
  const [payingId, setPayingId]   = useState<string | null>(null)
  const [voidingId, setVoidingId] = useState<string | null>(null)
  const [paymentsOpenId, setPaymentsOpenId] = useState<string | null>(null)
  const [busyId, setBusyId]       = useState<string | null>(null)
  const [error, setError]         = useState('')

  if (!permissions.viewFinancials) {
    return <p style={{ fontSize: 13, color: 'var(--text-3)' }}>You don&apos;t have permission to view billing on this project.</p>
  }

  const signedSows = (project.sow_documents || []).filter((s: any) => s.status === 'signed')
  const acceptedCos = (project.change_orders || []).filter((c: any) => c.status === 'accepted')
  const billableMilestones = milestones.filter((m: any) => m.status !== 'paid')

  // Phase 4: latest reconciliation snapshot, falling back to a live
  // computation from the props already on hand if the daily rollup cron
  // hasn't run yet for a brand-new project (snapshot table starts empty).
  const latestSnapshot = reconciliation.length ? reconciliation[reconciliation.length - 1] : null
  const liveInvoiced = invoices.filter((i: any) => !['draft', 'void'].includes(i.status)).reduce((s: number, i: any) => s + Number(i.amount || 0), 0)
  const livePaid      = invoices.filter((i: any) => !['draft', 'void'].includes(i.status)).reduce((s: number, i: any) => s + Number(i.amount_paid || 0), 0)
  const invoicedToDate = latestSnapshot ? latestSnapshot.invoiced_to_date : liveInvoiced
  const paidToDate      = latestSnapshot ? latestSnapshot.paid_to_date : livePaid
  // FIX (doc-completeness audit, migration 014): a CO awaiting
  // countersignature is still open money, same as awaiting_response/
  // countered — omitting it would understate at-risk value the moment
  // the agency accepts a counter, right up until the client re-signs.
  const atRiskValue      = latestSnapshot ? latestSnapshot.at_risk_value : acceptedCos.length === 0
    ? (project.change_orders || []).filter((c: any) => ['awaiting_response', 'countered', 'awaiting_countersignature'].includes(c.status)).reduce((s: number, c: any) => s + (c.total || 0), 0)
    : 0

  async function refresh() { router.refresh() }

  async function sendInvoice(id: string) {
    setBusyId(id); setError('')
    try {
      const res = await fetch(`/api/invoices/${id}/send`, { method: 'POST' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      await refresh()
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Failed to send invoice') }
    finally { setBusyId(null) }
  }

  async function remindInvoice(id: string) {
    setBusyId(id); setError('')
    try {
      const res = await fetch(`/api/invoices/${id}/remind`, { method: 'POST' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      alert('Reminder sent.')
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Failed to send reminder') }
    finally { setBusyId(null) }
  }

  async function deleteInvoice(id: string) {
    if (!confirm('Delete this draft invoice? This cannot be undone.')) return
    setBusyId(id); setError('')
    try {
      const res = await fetch(`/api/invoices/${id}`, { method: 'DELETE' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      await refresh()
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Failed to delete invoice') }
    finally { setBusyId(null) }
  }

  return (
    <div>
      {error && <div className="auth-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Phase 4: reconciliation summary */}
      <div style={{ display: 'flex', gap: 28, marginBottom: 20, flexWrap: 'wrap' }}>
        <MetricBlock label="Contracted" value={formatCurrency(project.contract_value || 0, currency)} />
        <MetricBlock label="Invoiced to date" value={formatCurrency(invoicedToDate, currency)} color="var(--blue)" />
        <MetricBlock label="Paid to date" value={formatCurrency(paidToDate, currency)} color="var(--green)" />
        {atRiskValue > 0 && <MetricBlock label="At risk (pending COs)" value={formatCurrency(atRiskValue, currency)} color="var(--gold)" />}
      </div>
      {!latestSnapshot && (
        <p style={{ fontSize: 11.5, color: 'var(--text-4)', marginTop: -12, marginBottom: 20 }}>
          Live figures shown — the daily reconciliation snapshot hasn&apos;t run yet for this project.
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="sec-title">Invoices ({invoices.length})</div>
        {permissions.sendInvoices && (
          <button className="btn btn-ghost btn-sm" onClick={() => setCreating(true)}>
            <i className="ti ti-plus" style={{ fontSize: 12 }} /> New invoice
          </button>
        )}
      </div>

      {invoices.length === 0 ? (
        <div className="empty-state">
          <i className="ti ti-receipt-2" style={{ fontSize: 22 }} />
          <p>No invoices yet on this project.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {invoices.map((inv: any) => {
            const balance = Math.max(0, Number(inv.amount) - Number(inv.amount_paid))
            return (
              <div key={inv.id} className="surface surface-p">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{inv.title}</span>
                      <span className={`pill pill-${invoicePill(inv.status)}`}>{invoiceStatusLabel(inv.status)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {inv.invoice_number ? `${inv.invoice_number} · ` : ''}
                      {inv.sent_at ? `Sent ${formatDate(inv.sent_at)}` : 'Not sent yet'}
                      {inv.due_date && <> · Due {formatDate(inv.due_date)}</>}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 17, fontFamily: 'Cormorant Garamond, Georgia, serif' }}>
                      {formatCurrency(inv.amount, inv.currency || currency)}
                    </div>
                    {inv.amount_paid > 0 && inv.status !== 'paid' && (
                      <div style={{ fontSize: 11.5, color: 'var(--green)' }}>
                        {formatCurrency(inv.amount_paid, inv.currency || currency)} paid · {formatCurrency(balance, inv.currency || currency)} due
                      </div>
                    )}
                    {inv.amount_paid > 0 && permissions.sendInvoices && (
                      <button
                        style={{ fontSize: 11, marginTop: 2, background: 'none', border: 'none', padding: 0, color: 'var(--text-3)', textDecoration: 'underline', cursor: 'pointer' }}
                        onClick={() => setPaymentsOpenId(paymentsOpenId === inv.id ? null : inv.id)}>
                        {paymentsOpenId === inv.id ? 'Hide payments' : 'View payments'}
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  {inv.status === 'draft' && permissions.sendInvoices && (
                    <>
                      <button className="btn btn-ghost btn-sm" disabled={busyId === inv.id} onClick={() => sendInvoice(inv.id)}>
                        {busyId === inv.id ? <span className="spin spin-dark" /> : <><i className="ti ti-send" style={{ fontSize: 11 }} /> Send</>}
                      </button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={busyId === inv.id} onClick={() => deleteInvoice(inv.id)}>
                        <i className="ti ti-trash" style={{ fontSize: 11 }} /> Delete
                      </button>
                    </>
                  )}
                  {['sent', 'partially_paid', 'overdue'].includes(inv.status) && (
                    <>
                      {permissions.sendInvoices && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setPayingId(inv.id)}>
                          <i className="ti ti-cash" style={{ fontSize: 11 }} /> Record payment
                        </button>
                      )}
                      {permissions.sendInvoices && (
                        <button className="btn btn-ghost btn-sm" disabled={busyId === inv.id} onClick={() => remindInvoice(inv.id)}>
                          {busyId === inv.id ? <span className="spin spin-dark" /> : <><i className="ti ti-bell" style={{ fontSize: 11 }} /> Remind</>}
                        </button>
                      )}
                      <a href={`/api/pdf/invoice/${inv.id}`} className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer">
                        <i className="ti ti-download" style={{ fontSize: 11 }} /> PDF
                      </a>
                      {inv.token && (
                        <button className="btn btn-ghost btn-sm" onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/portal/invoice/${inv.token}`)
                          alert('Client link copied.')
                        }}>
                          <i className="ti ti-link" style={{ fontSize: 11 }} /> Copy link
                        </button>
                      )}
                      {permissions.sendInvoices && (
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => setVoidingId(inv.id)}>
                          <i className="ti ti-ban" style={{ fontSize: 11 }} /> Void
                        </button>
                      )}
                    </>
                  )}
                  {inv.status === 'paid' && (
                    <a href={`/api/pdf/invoice/${inv.id}`} className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer">
                      <i className="ti ti-download" style={{ fontSize: 11 }} /> PDF
                    </a>
                  )}
                </div>

                {paymentsOpenId === inv.id && (
                  <PaymentsPanel invoice={inv} currency={currency} onChanged={refresh} />
                )}
              </div>
            )
          })}
        </div>
      )}

      {creating && (
        <CreateInvoiceModal
          projectId={project.id}
          projectCurrency={currency}
          milestones={billableMilestones}
          sows={signedSows}
          cos={acceptedCos}
          defaultPaymentInstructions={defaultPaymentInstructions}
          onClose={() => setCreating(false)}
          onCreated={async () => { setCreating(false); await refresh() }}
        />
      )}

      {payingId && (
        <RecordPaymentModal
          invoice={invoices.find((i: any) => i.id === payingId)}
          onClose={() => setPayingId(null)}
          onRecorded={async () => { setPayingId(null); await refresh() }}
        />
      )}

      {voidingId && (
        <VoidInvoiceModal
          invoice={invoices.find((i: any) => i.id === voidingId)}
          onClose={() => setVoidingId(null)}
          onVoided={async () => { setVoidingId(null); await refresh() }}
        />
      )}
    </div>
  )
}

// ── PAYMENTS PANEL ────────────────────────────────────────────
// Lists an invoice's manually-recorded payments and lets an agency user
// undo a mis-entered one. Was previously only reachable via a raw DELETE
// to /api/invoices/[id]/payments/[paymentId] — no button existed anywhere.
function PaymentsPanel({ invoice, currency, onChanged }: any) {
  const [payments, setPayments] = useState<any[] | null>(null)
  const [loading, setLoading]   = useState(true)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError]       = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const res  = await fetch(`/api/invoices/${invoice.id}/payments`)
        const json = await res.json()
        if (!cancelled) setPayments(json.payments || [])
      } finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [invoice.id])

  async function remove(paymentId: string) {
    if (!confirm('Remove this payment? The invoice balance will update immediately.')) return
    setRemovingId(paymentId); setError('')
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/payments/${paymentId}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (res.ok) {
        setPayments((prev) => (prev || []).filter((p) => p.id !== paymentId))
        await onChanged()
      } else setError(json.error || 'Could not remove that payment.')
    } finally { setRemovingId(null) }
  }

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      {loading ? (
        <p style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading payments…</p>
      ) : !payments || payments.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-3)' }}>No payments recorded yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {payments.map((p: any) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
              <div>
                <strong>{formatCurrency(p.amount, invoice.currency || currency)}</strong>
                <span style={{ color: 'var(--text-3)' }}>
                  {' '}· {METHOD_LABELS[p.method] || p.method} · {formatDate(p.paid_at)}
                  {p.reference_note ? ` · ${p.reference_note}` : ''}
                  {p.users?.name ? ` · logged by ${p.users.name}` : ''}
                </span>
              </div>
              <button
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--red)', cursor: 'pointer', fontSize: 12 }}
                disabled={removingId === p.id} onClick={() => remove(p.id)}>
                {removingId === p.id ? <span className="spin spin-dark" /> : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p style={{ fontSize: 11.5, color: 'var(--red)', marginTop: 6 }}>{error}</p>}
    </div>
  )
}

function MetricBlock({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 19, color: color || 'var(--text)' }}>{value}</div>
    </div>
  )
}

// ── CREATE INVOICE ────────────────────────────────────────────
function CreateInvoiceModal({ projectId, projectCurrency, milestones, sows, cos, defaultPaymentInstructions, onClose, onCreated }: any) {
  const [source, setSource] = useState<{ type: 'milestone' | 'sow' | 'co' | ''; id: string }>({ type: '', id: '' })
  const [title, setTitle]   = useState('')
  const [amount, setAmount] = useState('')
  const [dueDate, setDueDate] = useState('')
  // FIX (doc-completeness audit): workspace Settings had a "default payment
  // instructions" field that was saved but never actually used anywhere —
  // every invoice started blank regardless. Prefill from it; still editable
  // per-invoice.
  const [paymentInstructions, setPaymentInstructions] = useState(defaultPaymentInstructions || '')
  // FIX (doc-completeness audit, finding #2): invoices previously had no
  // way to carry tax at all. Defaults to 0 (no behavior change for
  // agencies that don't need it); the amount entered is always the final
  // amount the client owes — this rate just breaks it out on the PDF.
  const [taxRate, setTaxRate] = useState('0')
  const [taxInclusive, setTaxInclusive] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // FIX (doc-quality audit round 3): invoices could only ever bill a
  // single flat line ("Wave 2 completion — $71,000"), but real invoices
  // routinely mix a fixed-fee milestone with hourly T&M hours and a
  // reimbursable expense line in one document (see the Meridian sample).
  // Itemizing is opt-in — the common case (one flat amount) is unchanged
  // — and mirrors CoEditor's line-item table exactly so the two forms
  // feel like the same product. When itemized, `amount` is DERIVED from
  // the rows (same convention CO already uses for `subtotal`), so there's
  // no way for the UI to produce a total that doesn't foot to its own
  // line items — the server-side validation in POST /api/invoices is a
  // second belt-and-suspenders check, not the primary guard.
  const [itemized, setItemized] = useState(false)
  const [lineItems, setLineItems] = useState<Array<{ id: string; description: string; quantity: number; rate: number; total: number }>>(
    [{ id: nanoid(), description: '', quantity: 1, rate: 0, total: 0 }]
  )
  const itemsSubtotal = lineItems.reduce((s, l) => s + l.total, 0)

  function updateLineItem(id: string, field: 'description' | 'quantity' | 'rate', value: string | number) {
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
  // Keeps `amount` mirroring the line-item sum while itemized, so the
  // existing tax/due-date/submit logic below (all built around a single
  // `amount` figure) works unmodified either way.
  useEffect(() => {
    if (itemized) setAmount(itemsSubtotal ? String(itemsSubtotal) : '')
  }, [itemized, itemsSubtotal])

  function pickSource(type: 'milestone' | 'sow' | 'co', id: string) {
    setSource({ type, id })
    if (type === 'milestone') {
      const m = milestones.find((x: any) => x.id === id)
      if (m) { setTitle(m.title); if (!itemized) setAmount(String(m.amount)) }
    } else if (type === 'sow') {
      const s = sows.find((x: any) => x.id === id)
      if (s) setTitle(`SOW v${s.version}${s.document_number ? ` (${s.document_number})` : ''}`)
    } else if (type === 'co') {
      const c = cos.find((x: any) => x.id === id)
      if (c) { setTitle(c.title); if (!itemized) setAmount(String(c.total)) }
    }
  }

  async function submit() {
    setError('')
    if (!source.type || !source.id) { setError('Select what this invoice is billing against.'); return }
    if (!title.trim()) { setError('Title is required.'); return }
    if (!amount || Number(amount) <= 0) { setError('Enter a valid amount.'); return }
    const cleanItems = itemized ? lineItems.filter(l => l.description.trim()) : []
    if (itemized && cleanItems.length === 0) { setError('Add at least one line item, or turn off itemizing.'); return }

    setSubmitting(true)
    try {
      const res = await fetch('/api/invoices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId, title: title.trim(), amount: Number(amount), dueDate: dueDate || undefined,
          paymentInstructions: paymentInstructions || undefined,
          taxRate: Number(taxRate) || 0, taxInclusive,
          lineItems: cleanItems.length > 0 ? cleanItems.map(({ id, ...rest }) => rest) : undefined,
          milestoneId: source.type === 'milestone' ? source.id : undefined,
          sowId: source.type === 'sow' ? source.id : undefined,
          coId: source.type === 'co' ? source.id : undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      onCreated()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice')
    } finally { setSubmitting(false) }
  }

  const hasNoSources = milestones.length === 0 && sows.length === 0 && cos.length === 0

  return (
    <>
      <div className="modal-bg" onClick={onClose} />
      <div className="modal" style={{ maxWidth: 520 }}>
        <h2 className="modal-title">New invoice</h2>
        <p className="modal-sub">Bill against a milestone, a signed SOW, or an accepted change order.</p>
        {error && <p className="ferr" style={{ marginBottom: 10 }}>{error}</p>}

        {hasNoSources ? (
          <p style={{ fontSize: 13, color: 'var(--text-3)', padding: '16px 0' }}>
            Nothing billable yet — this project needs a payment milestone, a signed SOW, or an accepted change order first.
          </p>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>Bill against</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                {milestones.map((m: any) => (
                  <SourceRow key={m.id} active={source.type === 'milestone' && source.id === m.id}
                    label={m.title} sub={`Milestone · ${formatCurrency(m.amount, projectCurrency)}`}
                    onClick={() => pickSource('milestone', m.id)} />
                ))}
                {sows.map((s: any) => (
                  <SourceRow key={s.id} active={source.type === 'sow' && source.id === s.id}
                    label={`SOW v${s.version}`} sub={s.document_number || 'Signed SOW'}
                    onClick={() => pickSource('sow', s.id)} />
                ))}
                {cos.map((c: any) => (
                  <SourceRow key={c.id} active={source.type === 'co' && source.id === c.id}
                    label={c.title} sub={`Accepted CO · ${formatCurrency(c.total, projectCurrency)}`}
                    onClick={() => pickSource('co', c.id)} />
                ))}
              </div>
            </div>

            <div className="f2" style={{ marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Title</label>
                <input className="finp" value={title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)} placeholder="e.g. Milestone 2 — Design phase" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Amount ({projectCurrency})</label>
                <input type="number" className="finp" value={amount} disabled={itemized}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)} min={0} step="0.01" />
                {itemized && <p style={{ fontSize: 10.5, color: 'var(--text-4)', marginTop: 4 }}>Set by line items below</p>}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setItemized(v => !v)}>
                <i className={`ti ${itemized ? 'ti-list-numbers' : 'ti-plus'}`} style={{ fontSize: 12 }} />
                {itemized ? 'Itemizing this invoice' : 'Itemize this invoice'}
              </button>
              {itemized && (
                <span style={{ fontSize: 10.5, color: 'var(--text-4)', marginLeft: 8 }}>
                  For mixed billing — fixed fee + hourly + reimbursable, all in one invoice
                </span>
              )}
            </div>

            {itemized && (
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
                      placeholder={`Item ${idx + 1} — e.g. Hypercare support`}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'description', e.target.value)} />
                    <input type="number" className="finp" style={{ width: 64, fontSize: 12, textAlign: 'center' }}
                      value={item.quantity} min={0} step="0.01"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'quantity', parseFloat(e.target.value) || 0)} />
                    <input type="number" className="finp" style={{ width: 100, fontSize: 12, textAlign: 'right' }}
                      value={item.rate} min={0} step="0.01"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'rate', parseFloat(e.target.value) || 0)} />
                    <div style={{ width: 100, textAlign: 'right', fontSize: 13, fontFamily: 'IBM Plex Mono, monospace', color: 'var(--text-2)' }}>
                      {formatCurrency(item.total, projectCurrency)}
                    </div>
                    <div style={{ width: 32, textAlign: 'right' }}>
                      {lineItems.length > 1 && (
                        <button className="btn-icon" onClick={() => removeLine(item.id)}>
                          <i className="ti ti-x" style={{ fontSize: 12 }} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}

                <button className="btn btn-ghost btn-sm" onClick={addLine} style={{ marginTop: 6 }}>
                  <i className="ti ti-plus" style={{ fontSize: 12 }} /> Add line item
                </button>

                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600 }}>
                  <span>Total</span>
                  <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrency(itemsSubtotal, projectCurrency)}</span>
                </div>
              </div>
            )}

            <div className="f2" style={{ marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Tax rate (%) <span style={{ fontWeight: 400, color: 'var(--text-4)' }}>— optional</span></label>
                <input type="number" className="finp" value={taxRate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTaxRate(e.target.value)} min={0} max={100} step="0.01" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Amount entered above is</label>
                <select className="finp" value={taxInclusive ? 'inclusive' : 'exclusive'}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTaxInclusive(e.target.value === 'inclusive')}
                  disabled={Number(taxRate) <= 0}>
                  <option value="inclusive">Tax-inclusive</option>
                  <option value="exclusive">Before tax</option>
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Due date <span style={{ fontWeight: 400, color: 'var(--text-4)' }}>— optional</span></label>
              <input type="date" className="finp" value={dueDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDueDate(e.target.value)} />
            </div>

            <div style={{ marginBottom: 6 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Payment instructions <span style={{ fontWeight: 400, color: 'var(--text-4)' }}>— shown to the client</span></label>
              <RichTextField
                value={paymentInstructions}
                onChange={setPaymentInstructions}
                minHeight={70}
                placeholder='Bank details or "per contract terms"'
              />
            </div>
          </>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {!hasNoSources && (
            <button className="btn" onClick={submit} disabled={submitting}>
              {submitting ? <span className="spin" /> : 'Create draft'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function SourceRow({ active, label, sub, onClick }: { active: boolean; label: string; sub: string; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '9px 12px', border: `1px solid ${active ? 'var(--green)' : 'var(--border)'}`,
      background: active ? 'var(--surface-2)' : 'transparent',
      borderRadius: 'var(--radius-sm)', cursor: 'pointer',
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{sub}</div>
      </div>
      {active && <i className="ti ti-check" style={{ fontSize: 14, color: 'var(--green)' }} />}
    </div>
  )
}

// ── RECORD PAYMENT ────────────────────────────────────────────
function RecordPaymentModal({ invoice, onClose, onRecorded }: any) {
  const balance = Math.max(0, Number(invoice.amount) - Number(invoice.amount_paid))
  const [amount, setAmount] = useState(String(balance))
  const [paidAt, setPaidAt] = useState(new Date().toISOString().split('T')[0])
  const [method, setMethod] = useState('bank_transfer')
  const [referenceNote, setReferenceNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setError('')
    if (!amount || Number(amount) <= 0) { setError('Enter a valid amount.'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/payments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(amount), paidAt, method, referenceNote: referenceNote.trim() || undefined }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      onRecorded()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to record payment')
    } finally { setSubmitting(false) }
  }

  return (
    <>
      <div className="modal-bg" onClick={onClose} />
      <div className="modal" style={{ maxWidth: 440 }}>
        <h2 className="modal-title">Record payment</h2>
        <p className="modal-sub">Log money you received outside ScopeGov for &ldquo;{invoice.title}&rdquo;. Balance due: {formatCurrency(balance, invoice.currency)}.</p>
        {error && <p className="ferr" style={{ marginBottom: 10 }}>{error}</p>}

        <div className="f2" style={{ marginBottom: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Amount ({invoice.currency})</label>
            <input type="number" className="finp" value={amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)} min={0} max={balance} step="0.01" autoFocus />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Date received</label>
            <input type="date" className="finp" value={paidAt} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPaidAt(e.target.value)} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Method</label>
          <select className="finp" value={method} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setMethod(e.target.value)}>
            {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 6 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Reference <span style={{ fontWeight: 400, color: 'var(--text-4)' }}>— optional, e.g. wire confirmation #</span></label>
          <input className="finp" value={referenceNote} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReferenceNote(e.target.value)} placeholder="Wire confirmation, check number, etc." />
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submit} disabled={submitting}>
            {submitting ? <span className="spin" /> : 'Record payment'}
          </button>
        </div>
      </div>
    </>
  )
}

// ── VOID INVOICE ──────────────────────────────────────────────
function VoidInvoiceModal({ invoice, onClose, onVoided }: any) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setError(''); setSubmitting(true)
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/void`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      onVoided()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to void invoice')
    } finally { setSubmitting(false) }
  }

  return (
    <>
      <div className="modal-bg" onClick={onClose} />
      <div className="modal" style={{ maxWidth: 440 }}>
        <h2 className="modal-title">Void invoice</h2>
        <p className="modal-sub">The client&apos;s link to &ldquo;{invoice.title}&rdquo; will stop working. This can&apos;t be undone.</p>
        {error && <p className="ferr" style={{ marginBottom: 10 }}>{error}</p>}
        <textarea className="finp" style={{ minHeight: 70, marginBottom: 14 }} value={reason}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
          placeholder="Optional: reason for voiding" />
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={submit} disabled={submitting}>
            {submitting ? <span className="spin" style={{ borderColor: 'rgba(185,28,28,.2)', borderTopColor: '#B91C1C' }} /> : 'Void invoice'}
          </button>
        </div>
      </div>
    </>
  )
}
