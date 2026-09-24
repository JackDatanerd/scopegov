// components/invoices/BillingTab.tsx
//
// Phase 4a (client invoicing) + Phase 4 (contract reconciliation), scoped
// to a single project. Workspace-wide invoice list lives at /invoices
// (app/(app)/invoices/page.tsx) and links back here for any action.

'use client'
import { useState, useEffect } from 'react'
import { nanoid } from 'nanoid'
import { formatCurrency, formatCurrencyExact, roundCurrency, formatDate, invoiceStatusLabel, invoicePill } from '@/lib/utils/format'
import RichTextField from '@/components/ui/RichTextField'
import { baseContractValue } from '@/lib/reports/contract-position'

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
  billingDefaults?: { taxRate: number; taxInclusive: boolean; paymentTermsDays: number | null }
  // FIX (section-12 audit — feature gap follow-through): invoices can now
  // be gated by an approval workflow (see /api/invoices/[id]/send). An
  // invoice's own status stays 'draft' the whole time it's pending — this
  // is the only signal the UI has that a draft is actually "sent for
  // approval" rather than just sitting untouched, same reasoning as the
  // sow:<id>/co:<id> map ProjectDetail.tsx already threads to the SOW/CO
  // tabs. Keyed "invoice:<id>".
  pendingApprovals?: Record<string, { id: string; current_step: number; total_steps: number; sendFailed?: boolean; sendFailedReason?: string | null }>
}

export default function BillingTab({ project, milestones, invoices, reconciliation, permissions, currency, router, defaultPaymentInstructions = '', billingDefaults, pendingApprovals = {} }: Props) {
  const [creating, setCreating]   = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
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
  // FIX (section-12 audit): this only excluded 'paid' milestones from the
  // "Bill against" picker — a milestone already 'invoiced' (a sent invoice
  // already exists against it) was still offered right back to the
  // agency, which is exactly how the double-invoicing bug happened in
  // practice, not just via API tampering. Matches the API-level fix in
  // POST /api/invoices.
  const billableMilestones = milestones.filter((m: any) => m.status !== 'paid' && m.status !== 'invoiced')

  // FIX (section-12 fix round, flagship finding): a signed SOW or accepted
  // CO stayed selectable in "Bill against" no matter how many invoices
  // already existed against it — unlike milestones (excluded above the
  // moment one is 'invoiced'/'paid'), nothing here ever tracked how much
  // of the source's own value had already been billed. That let an agency
  // pick the same signed SOW or accepted CO twice and send a client two
  // full invoices for the same signed scope, with no warning anywhere in
  // the picker. `remaining` mirrors the cumulative cap now enforced
  // server-side (POST/PATCH /api/invoices) — the sum of every non-void
  // invoice already issued against that exact source, subtracted from the
  // source's own value. Anything fully billed (remaining <= 0) drops out
  // of the picker entirely; anything partially billed still shows up, but
  // annotated with what's actually left to invoice.
  const alreadyInvoicedAgainst = (column: 'sow_id' | 'co_id', id: string) =>
    invoices
      .filter((i: any) => i[column] === id && i.status !== 'void')
      .reduce((s: number, i: any) => s + Number(i.subtotal ?? i.amount ?? 0), 0)
  const billableSows = signedSows
    // FIX (re-audit, section-12 finding): remaining used the raw
    // project.contract_value column directly, which for a retainer
    // project is only the MONTHLY rate — the picker showed (and the
    // API enforced) a "remaining" figure capped at one month's fee no
    // matter how many months the term actually covers. baseContractValue()
    // is the same helper the reconciliation/dashboard numbers already use
    // for this exact reason.
    .map((s: any) => ({ ...s, remaining: baseContractValue(project) - alreadyInvoicedAgainst('sow_id', s.id) }))
    .filter((s: any) => s.remaining > 0.01)
  const billableCos = acceptedCos
    .map((c: any) => ({ ...c, remaining: Number(c.subtotal || 0) - alreadyInvoicedAgainst('co_id', c.id) }))
    .filter((c: any) => c.remaining > 0.01)

  // Phase 4: latest reconciliation snapshot, falling back to a live
  // computation from the props already on hand if the daily rollup cron
  // hasn't run yet for a brand-new project (snapshot table starts empty).
  const latestSnapshot = reconciliation.length ? reconciliation[reconciliation.length - 1] : null
  // FIX (fix round, section-12 flagship finding): duplicate of the same
  // pre-tax/post-tax mismatch fixed in cron/reconciliation-rollup — this
  // live fallback (used whenever a project has no snapshot yet, e.g. every
  // brand-new project before the first cron run) summed `amount` (tax-
  // inclusive) against `contract_value` (pre-tax) the same wrong way. A
  // fix to the cron alone wouldn't have closed this — this formula runs
  // independently and is what every new project actually shows first.
  const liveInvoiced = invoices.filter((i: any) => !['draft', 'void'].includes(i.status)).reduce((s: number, i: any) => s + Number(i.subtotal ?? i.amount ?? 0), 0)
  const livePaid      = invoices.filter((i: any) => !['draft', 'void'].includes(i.status)).reduce((s: number, i: any) => s + Number(i.amount_paid || 0), 0)
  const invoicedToDate = latestSnapshot ? latestSnapshot.invoiced_to_date : liveInvoiced
  const paidToDate      = latestSnapshot ? latestSnapshot.paid_to_date : livePaid
  // FIX (doc-completeness audit, migration 014): a CO awaiting
  // countersignature is still open money, same as awaiting_response/
  // countered — omitting it would understate at-risk value the moment
  // the agency accepts a counter, right up until the client re-signs.
  //
  // FIX (section-12 audit): the live-computation fallback used to be
  // gated behind `acceptedCos.length === 0` — the moment a project had
  // ANY accepted CO, this whole branch short-circuited to 0, silently
  // ignoring every OTHER, unrelated CO still open on the same project.
  // There's no reason one accepted CO should zero out the at-risk value
  // of a different CO still awaiting the client's response — that guard
  // served no purpose the surrounding comment describes and just
  // undercounted real open money to $0 for any project with more than
  // one CO in flight, until the daily reconciliation snapshot next runs.
  const atRiskValue      = latestSnapshot ? latestSnapshot.at_risk_value
    : (project.change_orders || []).filter((c: any) => ['awaiting_response', 'countered', 'awaiting_countersignature'].includes(c.status)).reduce((s: number, c: any) => s + (c.total || 0), 0)

  // FIX (re-audit, section-12 finding): the "Contracted" figure shown above
  // always read raw project.contract_value directly, instead of following
  // the same latestSnapshot-then-live-fallback pattern already used for
  // every other metric on this row. That's wrong two ways at once: for a
  // retainer project it's one month's rate, not rate × term (same root
  // cause as baseContractValue() below); and for ANY project with an
  // accepted change order, it silently excludes the CO's value entirely —
  // accepting a CO amends the contract via the `amendments` table, it does
  // NOT rewrite projects.contract_value (only a retainer-renewal CO does
  // that, via finalize-co.ts, and is deliberately excluded from
  // amendments for that reason so it isn't double-counted here). The
  // nightly snapshot's contracted_value (contract_reconciliation_snapshots,
  // written by cron/reconciliation-rollup from this exact same
  // computeContractPosition/baseContractValue logic) already gets this
  // right — this metric just never read it.
  const contractedValue = latestSnapshot ? latestSnapshot.contracted_value
    : baseContractValue(project) + acceptedCos.filter((c: any) => !c.is_retainer_renewal).reduce((s: number, c: any) => s + Number(c.total || 0), 0)

  async function refresh() { router.refresh() }

  async function sendInvoice(id: string) {
    // FIX (section-12 audit, pass 2): one click used to number the invoice, attach a PDF
    // and email the client with no confirmation — a mis-click on a permanent, legally
    // numbered document. SOW sends already ask first.
    if (!confirm('Send this invoice to the client now? It will be given its permanent invoice number and emailed with a PDF, and it can no longer be edited afterwards.')) return
    setBusyId(id); setError('')
    try {
      const res = await fetch(`/api/invoices/${id}/send`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Failed to send invoice')
      if (j.pendingApproval) alert('This invoice needs sign-off before it goes to the client — it has been sent for approval.')
      // FIX (Notifications & email fix round): a rejected email used to be
      // reported as a normal send. The invoice is issued either way; say so
      // when the client was NOT emailed, like the SOW and CO screens do.
      if (j.emailSent === false)
        alert(`The invoice is marked as sent, but the email to the client could not be delivered (${j.emailError || 'provider error'}).\n\nCheck the client's email address, then use Remind to try again.`)
      await refresh()
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Failed to send invoice') }
    finally { setBusyId(null) }
  }

  async function remindInvoice(id: string) {
    setBusyId(id); setError('')
    try {
      let res = await fetch(`/api/invoices/${id}/remind`, { method: 'POST' })
      // The client has an open dispute — the server asks before chasing them anyway.
      if (res.status === 409) {
        const j = await res.clone().json().catch(() => ({}))
        if (j.code === 'disputed') {
          if (!confirm(`${j.error}\n\nSend the reminder anyway?`)) return
          res = await fetch(`/api/invoices/${id}/remind`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }),
          })
        }
      }
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Failed to send reminder') }
      alert('Reminder sent.')
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Failed to send reminder') }
    finally { setBusyId(null) }
  }

  // FIX (section-12 audit, pass 2): an invoice whose approval finished but whose send
  // failed showed "Awaiting approval (n/n)" — read as still pending — with the Send
  // button hidden and no way to retry from here. The SOW and CO tabs already handle it.
  async function retryApprovalSend(approvalId: string, invoiceId: string) {
    setBusyId(invoiceId); setError('')
    try {
      const res = await fetch(`/api/approvals/${approvalId}/retry-send`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Retry failed')
      if (j.deliveryWarning) alert(j.deliveryWarning)
      await refresh()
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Retry failed') }
    finally { setBusyId(null) }
  }
  async function cancelApprovalFor(approvalId: string, invoiceId: string) {
    if (!confirm('Cancel this approved request? The invoice goes back to being an editable draft, and sending it again will need a fresh approval.')) return
    setBusyId(invoiceId); setError('')
    try {
      const res = await fetch(`/api/approvals/${approvalId}/cancel`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Could not cancel the request')
      window.dispatchEvent(new Event('scopegov:approvals-changed'))
      await refresh()
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Could not cancel the request') }
    finally { setBusyId(null) }
  }

  async function resolveDispute(id: string) {
    const note = window.prompt('Reply to the client (optional). They will be emailed this and shown it on the invoice page.')
    if (note === null) return // cancelled
    setBusyId(id); setError('')
    try {
      const res = await fetch(`/api/invoices/${id}/dispute-resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error)
      // FIX (section-11/12 fix round): `emailed` now reflects an actual delivery
      // check (see the route) instead of always being true whenever the code
      // reached the send call — say so when it's false, same as Send/Void above.
      if (json.emailed === false)
        alert('The dispute is marked resolved, but the notification email to the client could not be delivered. You may want to let them know directly.')
      await refresh()
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Failed to resolve the dispute') }
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
        <MetricBlock label="Contracted" value={formatCurrency(contractedValue, currency)} />
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
            const pendingApproval = inv.status === 'draft' ? pendingApprovals[`invoice:${inv.id}`] : null
            return (
              <div key={inv.id} className="surface surface-p">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{inv.title}</span>
                      <span className={`pill pill-${invoicePill(inv.status)}`}>{invoiceStatusLabel(inv.status)}</span>
                      {/* FIX (section-12 audit — feature gap follow-through):
                          mirrors the "Awaiting approval" pill already shown
                          on the SOW/CO tabs — without this, a gated
                          invoice just silently sat there with no visible
                          explanation for why it hadn't gone out. */}
                      {pendingApproval && pendingApproval.sendFailed && (
                        <span className="pill pill-red" title={pendingApproval.sendFailedReason || undefined}>
                          <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} /> Approved — not sent
                        </span>
                      )}
                      {pendingApproval && !pendingApproval.sendFailed && (
                        <span className="pill pill-amber">
                          <i className="ti ti-shield-check" style={{ fontSize: 10 }} /> Awaiting approval ({pendingApproval.current_step}/{pendingApproval.total_steps})
                        </span>
                      )}
                      {/* FIX (section-12 fix round, real feature gap): a
                          client's portal dispute (api/portal/invoice/
                          [token]/dispute) previously fired one email/
                          in-app notification and then vanished — nothing
                          in the agency's own UI ever showed disputed_at
                          again. Same visibility pattern as the
                          pending-approval pill right above. */}
                      {inv.disputed_at && !inv.dispute_resolved_at && (
                        <span className="pill pill-red" title={inv.dispute_note || undefined}>
                          <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} /> Client disputed {formatDate(inv.disputed_at)}
                        </span>
                      )}
                      {inv.disputed_at && inv.dispute_resolved_at && (
                        <span className="pill pill-green" title={inv.dispute_resolution_note || undefined}>
                          <i className="ti ti-circle-check" style={{ fontSize: 10 }} /> Dispute resolved {formatDate(inv.dispute_resolved_at)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {inv.invoice_number ? `${inv.invoice_number} · ` : ''}
                      {inv.sent_at ? `Sent ${formatDate(inv.sent_at)}` : 'Not sent yet'}
                      {inv.due_date && <> · Due {formatDate(inv.due_date)}</>}
                    </div>
                    {inv.disputed_at && inv.dispute_note && (
                      <div style={{ fontSize: 12, color: inv.dispute_resolved_at ? 'var(--text-3)' : 'var(--red)', marginTop: 4 }}>
                        &ldquo;{inv.dispute_note}&rdquo;
                      </div>
                    )}
                    {inv.disputed_at && inv.dispute_resolved_at && inv.dispute_resolution_note && (
                      <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 2 }}>
                        Your response: &ldquo;{inv.dispute_resolution_note}&rdquo;
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 17, fontFamily: 'Cormorant Garamond, Georgia, serif' }}>
                      {formatCurrencyExact(inv.amount, inv.currency || currency)}
                    </div>
                    {inv.amount_paid > 0 && inv.status !== 'paid' && (
                      <div style={{ fontSize: 11.5, color: 'var(--green)' }}>
                        {formatCurrencyExact(inv.amount_paid, inv.currency || currency)} paid · {formatCurrencyExact(balance, inv.currency || currency)} due
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
                  {inv.status === 'draft' && permissions.sendInvoices && !pendingApproval && (
                    <>
                      <button className="btn btn-ghost btn-sm" disabled={busyId === inv.id} onClick={() => sendInvoice(inv.id)}>
                        {busyId === inv.id ? <span className="spin spin-dark" /> : <><i className="ti ti-send" style={{ fontSize: 11 }} /> Send</>}
                      </button>
                      {/* FIX (section-12 audit, feature gap): PATCH
                          /api/invoices/[id] has always fully supported
                          editing a draft's title/amount/tax/line items/
                          due date/payment instructions — this button was
                          the only thing missing. Without it, fixing a typo
                          on a draft meant deleting it and starting over. */}
                      <button className="btn btn-ghost btn-sm" disabled={busyId === inv.id} onClick={() => setEditingId(inv.id)}>
                        <i className="ti ti-pencil" style={{ fontSize: 11 }} /> Edit
                      </button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={busyId === inv.id} onClick={() => deleteInvoice(inv.id)}>
                        <i className="ti ti-trash" style={{ fontSize: 11 }} /> Delete
                      </button>
                    </>
                  )}
                  {/* FIX (section-12 audit — feature gap follow-through):
                      once gated, PATCH /api/invoices/[id] and DELETE both
                      now reject with "cancel it first" (matching SOW/CO) —
                      this button routes there instead of leaving the
                      invoice with no visible next step. */}
                  {inv.status === 'draft' && pendingApproval && pendingApproval.sendFailed && permissions.sendInvoices && (
                    <>
                      <button className="btn btn-ghost btn-sm" disabled={busyId === inv.id} onClick={() => cancelApprovalFor(pendingApproval.id, inv.id)}>
                        Cancel request
                      </button>
                      <button className="btn btn-primary btn-sm" disabled={busyId === inv.id} onClick={() => retryApprovalSend(pendingApproval.id, inv.id)}>
                        {busyId === inv.id ? <span className="spin" /> : <><i className="ti ti-refresh" style={{ fontSize: 11 }} /> Retry send</>}
                      </button>
                    </>
                  )}
                  {inv.status === 'draft' && pendingApproval && !pendingApproval.sendFailed && (
                    <a href={`/approvals?highlight=${pendingApproval.id}`} className="btn btn-ghost btn-xs">
                      <i className="ti ti-shield-check" style={{ fontSize: 11 }} /> Awaiting approval
                    </a>
                  )}
                  {['sent', 'partially_paid', 'overdue'].includes(inv.status) && (
                    <>
                      {permissions.sendInvoices && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setPayingId(inv.id)}>
                          <i className="ti ti-cash" style={{ fontSize: 11 }} /> Record payment
                        </button>
                      )}
                      {permissions.sendInvoices && inv.disputed_at && !inv.dispute_resolved_at && (
                        <button className="btn btn-ghost btn-sm" disabled={busyId === inv.id} onClick={() => resolveDispute(inv.id)}>
                          {busyId === inv.id ? <span className="spin spin-dark" /> : <><i className="ti ti-circle-check" style={{ fontSize: 11 }} /> Resolve dispute</>}
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
                          navigator.clipboard.writeText(`${process.env.NEXT_PUBLIC_PORTAL_URL || window.location.origin}/portal/invoice/${inv.token}`)
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
          sows={billableSows}
          cos={billableCos}
          defaultPaymentInstructions={defaultPaymentInstructions}
          billingDefaults={billingDefaults}
          onClose={() => setCreating(false)}
          onCreated={async () => { setCreating(false); await refresh() }}
        />
      )}

      {editingId && (
        <EditInvoiceModal
          invoiceId={editingId}
          projectCurrency={currency}
          onClose={() => setEditingId(null)}
          onSaved={async () => { setEditingId(null); await refresh() }}
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
  // FEATURE (section-12 audit, pass 2): fix a payment's amount / date / method /
  // reference in place instead of deleting and re-entering it.
  const [editId, setEditId]     = useState<string | null>(null)
  const [draft, setDraft]       = useState<{ amount: string; paidAt: string; method: string; referenceNote: string }>({ amount: '', paidAt: '', method: 'other', referenceNote: '' })
  const [savingEdit, setSavingEdit] = useState(false)
  const isVoid = invoice.status === 'void'

  async function saveEdit(paymentId: string) {
    setSavingEdit(true); setError('')
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/payments/${paymentId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(draft.amount), paidAt: draft.paidAt, method: draft.method, referenceNote: draft.referenceNote }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not update that payment.')
      const listRes = await fetch(`/api/invoices/${invoice.id}/payments`)
      const listJson = await listRes.json().catch(() => ({}))
      setPayments(listJson.payments || [])
      setEditId(null)
      await onChanged()
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Could not update that payment.') }
    finally { setSavingEdit(false) }
  }

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
          {payments.map((p: any) => editId === p.id ? (
            <div key={p.id} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
              <input type="number" className="finp" style={{ width: 110 }} step="0.01" min={0} value={draft.amount}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, amount: e.target.value })} />
              <input type="date" className="finp" style={{ width: 150 }} value={draft.paidAt}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, paidAt: e.target.value })} />
              <select className="finp" style={{ width: 140 }} value={draft.method}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setDraft({ ...draft, method: e.target.value })}>
                {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}
              </select>
              <input className="finp" style={{ flex: 1, minWidth: 120 }} maxLength={500} placeholder="Reference" value={draft.referenceNote}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, referenceNote: e.target.value })} />
              <button className="btn btn-primary btn-xs" disabled={savingEdit} onClick={() => saveEdit(p.id)}>{savingEdit ? <span className="spin" /> : 'Save'}</button>
              <button className="btn btn-ghost btn-xs" disabled={savingEdit} onClick={() => setEditId(null)}>Cancel</button>
            </div>
          ) : (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
              <div>
                <strong>{formatCurrencyExact(p.amount, invoice.currency || currency)}</strong>
                <span style={{ color: 'var(--text-3)' }}>
                  {' '}· {METHOD_LABELS[p.method] || p.method} · {formatDate(p.paid_at)}
                  {p.reference_note ? ` · ${p.reference_note}` : ''}
                  {p.users?.name ? ` · logged by ${p.users.name}` : ''}
                </span>
              </div>
              {!isVoid && (
                <span style={{ display: 'flex', gap: 10 }}>
                  <button
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-3)', cursor: 'pointer', fontSize: 12 }}
                    onClick={() => { setEditId(p.id); setDraft({ amount: String(p.amount), paidAt: String(p.paid_at).slice(0, 10), method: p.method, referenceNote: p.reference_note || '' }) }}>
                    Edit
                  </button>
                  <button
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--red)', cursor: 'pointer', fontSize: 12 }}
                    disabled={removingId === p.id} onClick={() => remove(p.id)}>
                    {removingId === p.id ? <span className="spin spin-dark" /> : 'Remove'}
                  </button>
                </span>
              )}
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
// The due date `days` from today, as the yyyy-mm-dd a date input expects (local calendar day).
function dueDateFromTerms(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return ''
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function CreateInvoiceModal({ projectId, projectCurrency, milestones, sows, cos, defaultPaymentInstructions, billingDefaults, onClose, onCreated }: any) {
  const [source, setSource] = useState<{ type: 'milestone' | 'sow' | 'co' | ''; id: string }>({ type: '', id: '' })
  const [title, setTitle]   = useState('')
  const [amount, setAmount] = useState('')
  // FEATURE (Settings & Team round): workspace billing defaults pre-fill the due date and tax terms.
  // A milestone or change order picked below still brings its own terms over these.
  const defaultDue = dueDateFromTerms(billingDefaults?.paymentTermsDays)
  const [dueDate, setDueDate] = useState(defaultDue)
  // FIX (section-12 audit — feature gap): po_number was fully modeled and
  // rendered on every invoice PDF/portal view but had no input anywhere in
  // the product — see the create-route comment for the full explanation.
  const [poNumber, setPoNumber] = useState('')
  // FIX (doc-completeness audit): workspace Settings had a "default payment
  // instructions" field that was saved but never actually used anywhere —
  // every invoice started blank regardless. Prefill from it; still editable
  // per-invoice.
  const [paymentInstructions, setPaymentInstructions] = useState(defaultPaymentInstructions || '')
  // FIX (doc-completeness audit, finding #2): invoices previously had no
  // way to carry tax at all. Defaults to 0 (no behavior change for
  // agencies that don't need it); the amount entered is always the final
  // amount the client owes — this rate just breaks it out on the PDF.
  const [taxRate, setTaxRate] = useState(String(billingDefaults?.taxRate ?? 0))
  const [taxInclusive, setTaxInclusive] = useState<boolean>(billingDefaults?.taxInclusive ?? true)
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

  // AI draft — mirrors CoEditor's "Draft with AI" exactly: agency
  // describes what's being billed, model proposes a title + itemized
  // lines with pricing forced to 0 server-side, agency fills in rates
  // and revises for convenience.
  const [aiOpen,     setAiOpen]     = useState(false)
  const [aiText,     setAiText]     = useState('')
  const [aiDrafting, setAiDrafting] = useState(false)
  const [aiError,    setAiError]    = useState('')

  // FIX (invoice-convenience audit): a picked milestone already carries
  // `trigger` (NOT NULL — always present) and optional `notes`, which is
  // exactly the billing context the AI box was asking the agency to
  // retype from scratch. Seeds the textarea from what's already on file
  // so the agency reviews/edits instead of authoring from nothing — same
  // principle as the due-date/tax-rate fix in pickSource above.
  function milestoneSeedText(m: any): string {
    return [m?.trigger, m?.notes].filter(Boolean).join(' — ')
  }
  function openAiDraft() {
    setAiOpen(true)
    if (!aiText.trim() && source.type === 'milestone') {
      const m = milestones.find((x: any) => x.id === source.id)
      if (m) setAiText(milestoneSeedText(m))
    }
  }

  async function draftWithAi() {
    if (!aiText.trim()) { setAiError('Describe what this invoice covers first.'); return }
    setAiDrafting(true); setAiError('')
    try {
      const milestone = source.type === 'milestone' ? milestones.find((m: any) => m.id === source.id) : null
      const sourceLabel = milestone?.title
        ?? (source.type === 'sow'
          ? `SOW ${sows.find((s: any) => s.id === source.id)?.document_number || ''}`
          : source.type === 'co'
            ? cos.find((c: any) => c.id === source.id)?.title
            : undefined)
      // Structured milestone context — billing type (fixed/hourly_cap/
      // percentage/retainer_monthly) tells the model what shape of line
      // items to expect, on top of the trigger/notes prose already
      // folded into aiText above.
      const sourceContext = milestone
        ? { billingType: milestone.type, trigger: milestone.trigger, notes: milestone.notes }
        : undefined
      const res  = await fetch('/api/invoices/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, request: aiText, sourceLabel, sourceContext }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      if (json.title) setTitle(json.title)
      if (json.lineItems?.length) {
        setItemized(true)
        setLineItems(json.lineItems.map((li: any) => ({
          id: nanoid(), description: li.description, quantity: li.quantity || 1, rate: 0, total: 0,
        })))
      }
      setAiOpen(false); setAiText('')
    } catch (err: unknown) {
      setAiError(err instanceof Error ? err.message : 'Could not draft this — try again or fill it in manually.')
    } finally { setAiDrafting(false) }
  }

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
  // FIX (section-12 audit): the tax-inclusive/exclusive selector is
  // locked to "Before tax" in the UI while itemized (see the select
  // below), but locking the *display* isn't enough — `taxInclusive`
  // itself still defaulted to true and was what actually got sent to the
  // server. Keep the real state in sync with what's shown, so toggling
  // itemizing on doesn't submit `taxInclusive: true` behind a selector
  // that visually says otherwise.
  useEffect(() => {
    if (itemized) setTaxInclusive(false)
  }, [itemized])

  function pickSource(type: 'milestone' | 'sow' | 'co', id: string) {
    setSource({ type, id })
    if (type === 'milestone') {
      const m = milestones.find((x: any) => x.id === id)
      if (m) {
        setTitle(m.title)
        if (!itemized) setAmount(String(m.amount))
        // FIX (invoice-convenience audit): due_date, tax_rate, and
        // tax_inclusive are captured once on the milestone at SOW-build
        // time and were being silently discarded here — every invoice
        // against a milestone required retyping tax terms and a due date
        // the system already had on file. Same failure pattern as the
        // payment-instructions field before that got wired to Settings.
        setDueDate(m.due_date || defaultDue)
        // payment_milestones.tax_rate is NOT NULL DEFAULT 0 and nothing in the product sets it, so a
        // milestone's 0% means "no tax terms of its own", not "tax-free on purpose": fall back to the
        // workspace's billing defaults, and only let a milestone that really carries a rate win.
        const milestoneTaxed = (Number(m.tax_rate) || 0) > 0
        setTaxRate(milestoneTaxed ? String(m.tax_rate) : String(billingDefaults?.taxRate ?? 0))
        // FIX (section-12 audit): this unconditionally copied the
        // milestone's own tax_inclusive, but the effect above that forces
        // exclusive-tax while itemized only re-runs on `itemized`
        // changing, not on this. Picking a tax-inclusive milestone while
        // already itemizing would silently re-enable "tax inclusive"
        // behind the selector, which stays visually locked to "Before
        // tax" — the same display-vs-state mismatch that effect exists
        // to prevent. Respect the same invariant here.
        setTaxInclusive(itemized ? false : (milestoneTaxed ? (m.tax_inclusive ?? true) : (billingDefaults?.taxInclusive ?? true)))
      }
    } else if (type === 'sow') {
      const s = sows.find((x: any) => x.id === id)
      if (s) setTitle(`SOW v${s.version}${s.document_number ? ` (${s.document_number})` : ''}`)
    } else if (type === 'co') {
      const c = cos.find((x: any) => x.id === id)
      // FIX (section-12 audit, flagship finding): unlike the milestone
      // branch above — which explicitly copies tax_rate/tax_inclusive,
      // with a comment about exactly this failure pattern — this branch
      // only ever copied title/amount. The server (POST /api/invoices)
      // has a coTaxDefaults fallback that carries an accepted CO's own
      // tax terms onto the invoice specifically so "an accepted CO that
      // had 8% tax on it shouldn't turn into a plain untaxed invoice
      // line" — but that fallback only fires when `taxRate` is omitted
      // from the request body, and submit() below always sends a
      // concrete taxRate (defaulting to '0'), so it could never actually
      // trigger from this UI. Copy the CO's tax terms here too, the same
      // way the milestone branch already does (and under the same
      // itemized-forces-exclusive guard), so invoicing a taxed CO doesn't
      // silently drop the tax.
      if (c) {
        setTitle(c.title)
        // FIX (section-12 audit, pass 2): this pre-filled the CO's GROSS total (tax
        // included) even for a tax-EXCLUSIVE CO, where the field means the NET — the
        // server then read 1,160 as the pre-tax figure against a 1,000 cap and refused
        // it, so invoicing any taxed exclusive CO with the defaults always failed.
        // Pre-fill what still remains to bill: net when tax is exclusive, grossed up
        // when the form will treat the figure as tax-inclusive.
        if (!itemized) {
          const netRemaining = Number(c.remaining ?? c.subtotal ?? 0)
          const rate = Number(c.tax_rate) || 0
          const inclusive = (c.tax_inclusive ?? true) && rate > 0
          setAmount(String(inclusive ? roundCurrency(netRemaining * (1 + rate / 100)) : roundCurrency(netRemaining)))
        }
        setTaxRate(c.tax_rate != null ? String(c.tax_rate) : '0')
        setTaxInclusive(itemized ? false : (c.tax_inclusive ?? true))
      }
    }
  }

  async function submit() { await submitWith(false) }
  async function submitWith(acknowledgeOverContract: boolean) {
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
          poNumber: poNumber.trim() || undefined,
          taxRate: Number(taxRate) || 0, taxInclusive,
          lineItems: cleanItems.length > 0 ? cleanItems.map(({ id, ...rest }) => rest) : undefined,
          milestoneId: source.type === 'milestone' ? source.id : undefined,
          sowId: source.type === 'sow' ? source.id : undefined,
          coId: source.type === 'co' ? source.id : undefined,
          ...(acknowledgeOverContract ? { acknowledgeOverContract: true } : {}),
        }),
      })
      const json = await res.json()
      // FIX (section-12 audit, pass 2 — feature gap): the project-level over-invoicing check.
      if (res.status === 409 && json.code === 'over_contract') {
        setSubmitting(false)
        if (confirm(`${json.error}\n\nCreate this invoice anyway?`)) { await submitWith(true) }
        return
      }
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
                    label={m.title} sub={`Milestone · ${formatCurrencyExact(m.amount, projectCurrency)}`}
                    onClick={() => pickSource('milestone', m.id)} />
                ))}
                {sows.map((s: any) => (
                  <SourceRow key={s.id} active={source.type === 'sow' && source.id === s.id}
                    label={`SOW v${s.version}`}
                    sub={`${s.document_number || 'Signed SOW'} · ${formatCurrencyExact(s.remaining, projectCurrency)} remaining`}
                    onClick={() => pickSource('sow', s.id)} />
                ))}
                {cos.map((c: any) => (
                  <SourceRow key={c.id} active={source.type === 'co' && source.id === c.id}
                    label={c.title}
                    sub={`Accepted CO · ${formatCurrencyExact(c.remaining, projectCurrency)} remaining`}
                    onClick={() => pickSource('co', c.id)} />
                ))}
              </div>
            </div>

            {!aiOpen && (
              <button className="btn btn-ghost btn-sm" onClick={openAiDraft} style={{ marginBottom: 16 }}>
                <i className="ti ti-sparkles" style={{ fontSize: 12 }} /> Draft with AI
              </button>
            )}
            {aiOpen && (
              <div className="surface surface-p" style={{ marginBottom: 20 }}>
                <label className="flbl">Describe what this invoice covers</label>
                <textarea className="finp" style={{ minHeight: 80, resize: 'vertical', marginTop: 6 }} autoFocus
                  value={aiText} placeholder="e.g. Wave 2 fixed-fee milestone completion, plus 62 hours of October hypercare support at $145/hr, plus on-site travel expenses…"
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setAiText(e.target.value)} />
                {aiError && <p className="ferr" style={{ marginTop: 6 }}>{aiError}</p>}
                <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                  Drafts a title and itemized line items from your description — pricing is always left at 0 for you to set.
                </p>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" onClick={draftWithAi} disabled={aiDrafting}>
                    {aiDrafting ? <span className="spin" /> : 'Draft'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setAiOpen(false); setAiText(''); setAiError('') }}>Cancel</button>
                </div>
              </div>
            )}

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
                      {formatCurrencyExact(item.total, projectCurrency)}
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
                  <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrencyExact(itemsSubtotal, projectCurrency)}</span>
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
                {/* FIX (section-12 audit): when itemized, `amount` is the
                    raw sum of the line items below — a pre-tax figure by
                    construction, since no per-line tax is ever applied.
                    Leaving this selector live (defaulting to
                    "Tax-inclusive") let the server treat that pre-tax sum
                    as if it already included tax, which made itemizing +
                    any nonzero tax rate permanently unsaveable (see
                    POST /api/invoices). Line items are always "before
                    tax" once itemizing — lock the selector to match
                    what the server now enforces, instead of offering a
                    choice that silently breaks. */}
                <select className="finp" value={itemized ? 'exclusive' : (taxInclusive ? 'inclusive' : 'exclusive')}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTaxInclusive(e.target.value === 'inclusive')}
                  disabled={Number(taxRate) <= 0 || itemized}>
                  <option value="inclusive">Tax-inclusive</option>
                  <option value="exclusive">Before tax</option>
                </select>
                {itemized && Number(taxRate) > 0 && (
                  <p style={{ fontSize: 10.5, color: 'var(--text-4)', marginTop: 4 }}>
                    Line items are always entered before tax — tax is added on top of their total.
                  </p>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Due date <span style={{ fontWeight: 400, color: 'var(--text-4)' }}>— needed before it can be sent</span></label>
              <input type="date" className="finp" value={dueDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDueDate(e.target.value)} />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>PO number <span style={{ fontWeight: 400, color: 'var(--text-4)' }}>— optional, if the client requires one</span></label>
              <input className="finp" value={poNumber} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPoNumber(e.target.value)} placeholder="e.g. PO-4471" />
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

// ── EDIT DRAFT INVOICE ──────────────────────────────────────────
// FIX (section-12 audit, feature gap): PATCH /api/invoices/[id] has
// always fully supported editing a draft invoice's title, amount, tax
// terms, itemized line items, due date, and payment instructions — this
// modal was the missing piece that actually let an agency user reach it,
// instead of deleting and recreating a draft from scratch over a typo.
// Fetches the full invoice on open (the summary list BillingTab already
// has doesn't carry subtotal/tax/line_items/payment_instructions), same
// lazy-load pattern PaymentsPanel already uses below.
function EditInvoiceModal({ invoiceId, projectCurrency, onClose, onSaved }: {
  invoiceId: string; projectCurrency: string; onClose: () => void; onSaved: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [poNumber, setPoNumber] = useState('')
  const [paymentInstructions, setPaymentInstructions] = useState('')
  const [taxRate, setTaxRate] = useState('0')
  const [taxInclusive, setTaxInclusive] = useState(true)
  const [itemized, setItemized] = useState(false)
  const [lineItems, setLineItems] = useState<Array<{ id: string; description: string; quantity: number; rate: number; total: number }>>([])
  const itemsSubtotal = lineItems.reduce((s, l) => s + l.total, 0)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setLoadError('')
      try {
        const res  = await fetch(`/api/invoices/${invoiceId}`)
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || 'Failed to load invoice')
        if (cancelled) return
        const inv = json.invoice
        setTitle(inv.title || '')
        // FIX (fix round, section-12 flagship finding): this loaded
        // inv.amount (the stored GRAND TOTAL) into the "Amount" field
        // unconditionally — but per the same convention this form's own
        // submit() and the create route both follow, the field means
        // different things depending on tax_inclusive: when inclusive, it
        // IS the grand total (inv.amount is correct); when exclusive, the
        // field is supposed to hold the SUBTOTAL, which the server then
        // grosses up into a new amount. Loading the grand total into a
        // field the server treats as "pre-tax, to be grossed up" meant
        // merely opening Edit on any non-itemized, tax-exclusive, taxed
        // invoice and clicking Save with NO other changes — fixing a
        // typo in the title, say — silently re-grossed-up the total by
        // another (1 + rate) on every single save, compounding further
        // on every subsequent open-and-save. Itemized invoices were
        // already unaffected (a separate effect below re-derives `amount`
        // from the line-item sum), as are inclusive/untaxed invoices
        // (inv.amount already is the right figure for those). Loading
        // inv.subtotal here for the exclusive+taxed case is the fix —
        // it's exactly what the field represents in that mode.
        setAmount(String((inv.tax_rate > 0 && inv.tax_inclusive === false ? inv.subtotal : inv.amount) ?? ''))
        setDueDate(inv.due_date ? String(inv.due_date).slice(0, 10) : '')
        setPoNumber(inv.po_number || '')
        setPaymentInstructions(inv.payment_instructions || '')
        setTaxRate(inv.tax_rate != null ? String(inv.tax_rate) : '0')
        setTaxInclusive(inv.tax_inclusive ?? true)
        const items = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items || '[]') : (inv.line_items || [])
        if (items.length > 0) {
          setItemized(true)
          setLineItems(items.map((li: any) => ({ id: nanoid(), description: li.description, quantity: li.quantity, rate: li.rate, total: li.total })))
        } else {
          setLineItems([{ id: nanoid(), description: '', quantity: 1, rate: 0, total: 0 }])
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load invoice')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [invoiceId])

  // Same as CreateInvoiceModal: keeps `amount` mirroring the line-item
  // sum while itemized, and keeps taxInclusive from silently defaulting
  // to a state the itemized footing check can never satisfy — see the
  // matching fix in CreateInvoiceModal for the full explanation.
  useEffect(() => {
    if (itemized) setAmount(itemsSubtotal ? String(itemsSubtotal) : '')
  }, [itemized, itemsSubtotal])
  useEffect(() => {
    if (itemized) setTaxInclusive(false)
  }, [itemized])

  function updateLineItem(id: string, field: 'description' | 'quantity' | 'rate', value: string | number) {
    setLineItems(prev => prev.map(l => {
      if (l.id !== id) return l
      const updated = { ...l, [field]: value }
      updated.total = updated.quantity * updated.rate
      return updated
    }))
  }
  function addLine() { setLineItems(prev => [...prev, { id: nanoid(), description: '', quantity: 1, rate: 0, total: 0 }]) }
  function removeLine(id: string) {
    if (lineItems.length === 1) return
    setLineItems(prev => prev.filter(l => l.id !== id))
  }

  async function submit() {
    setError('')
    if (!title.trim()) { setError('Title is required.'); return }
    if (!amount || Number(amount) <= 0) { setError('Enter a valid amount.'); return }
    const cleanItems = itemized ? lineItems.filter(l => l.description.trim()) : []
    if (itemized && cleanItems.length === 0) { setError('Add at least one line item, or turn off itemizing.'); return }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/invoices/${invoiceId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(), amount: Number(amount),
          dueDate: dueDate || null, poNumber: poNumber.trim() || null, paymentInstructions,
          taxRate: Number(taxRate) || 0, taxInclusive,
          lineItems: itemized ? cleanItems.map(({ id, ...rest }) => rest) : [],
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to save changes')
      onSaved()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save changes')
    } finally { setSubmitting(false) }
  }

  return (
    <>
      <div className="modal-bg" onClick={onClose} />
      <div className="modal" style={{ maxWidth: 520 }}>
        <h2 className="modal-title">Edit draft invoice</h2>
        <p className="modal-sub">What this bills against can&apos;t be changed — void and re-create if that needs to change.</p>

        {loading ? (
          <div className="empty-state" style={{ padding: '24px 0' }}><span className="spin spin-dark" /></div>
        ) : loadError ? (
          <p className="ferr">{loadError}</p>
        ) : (
          <>
            {error && <p className="ferr" style={{ marginBottom: 10 }}>{error}</p>}

            <div className="f2" style={{ marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Title</label>
                <input className="finp" value={title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)} />
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
                      placeholder={`Item ${idx + 1}`}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'description', e.target.value)} />
                    <input type="number" className="finp" style={{ width: 64, fontSize: 12, textAlign: 'center' }}
                      value={item.quantity} min={0} step="0.01"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'quantity', parseFloat(e.target.value) || 0)} />
                    <input type="number" className="finp" style={{ width: 100, fontSize: 12, textAlign: 'right' }}
                      value={item.rate} min={0} step="0.01"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLineItem(item.id, 'rate', parseFloat(e.target.value) || 0)} />
                    <div style={{ width: 100, textAlign: 'right', fontSize: 13, fontFamily: 'IBM Plex Mono, monospace', color: 'var(--text-2)' }}>
                      {formatCurrencyExact(item.total, projectCurrency)}
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
                  <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{formatCurrencyExact(itemsSubtotal, projectCurrency)}</span>
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
                <select className="finp" value={itemized ? 'exclusive' : (taxInclusive ? 'inclusive' : 'exclusive')}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTaxInclusive(e.target.value === 'inclusive')}
                  disabled={Number(taxRate) <= 0 || itemized}>
                  <option value="inclusive">Tax-inclusive</option>
                  <option value="exclusive">Before tax</option>
                </select>
                {itemized && Number(taxRate) > 0 && (
                  <p style={{ fontSize: 10.5, color: 'var(--text-4)', marginTop: 4 }}>
                    Line items are always entered before tax — tax is added on top of their total.
                  </p>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Due date <span style={{ fontWeight: 400, color: 'var(--text-4)' }}>— needed before it can be sent</span></label>
              <input type="date" className="finp" value={dueDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDueDate(e.target.value)} />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>PO number <span style={{ fontWeight: 400, color: 'var(--text-4)' }}>— optional, if the client requires one</span></label>
              <input className="finp" value={poNumber} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPoNumber(e.target.value)} placeholder="e.g. PO-4471" />
            </div>

            <div style={{ marginBottom: 6 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>Payment instructions <span style={{ fontWeight: 400, color: 'var(--text-4)' }}>— shown to the client</span></label>
              <RichTextField value={paymentInstructions} onChange={setPaymentInstructions} minHeight={70} placeholder='Bank details or "per contract terms"' />
            </div>
          </>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {!loading && !loadError && (
            <button className="btn" onClick={submit} disabled={submitting}>
              {submitting ? <span className="spin" /> : 'Save changes'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// ── SOURCE PICKER ────────────────────────────────────────────
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
  const [amount, setAmount] = useState(roundCurrency(balance).toFixed(2))
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
        <p className="modal-sub">Log money you received outside ScopeGov for &ldquo;{invoice.title}&rdquo;. Balance due: {formatCurrencyExact(balance, invoice.currency)}.</p>
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
  // FIX (section-12 audit, pass 2 — feature gap): voiding a part-paid invoice used to
  // mean deleting its payment records first. They now stay on file; the person voiding
  // has to say why and confirm that money was already received.
  const paid = Number(invoice.amount_paid) || 0

  async function submit() {
    if (paid > 0 && !reason.trim()) { setError('Give a reason — money has already been received on this invoice.'); return }
    setError(''); setSubmitting(true)
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/void`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || undefined, ...(paid > 0 ? { acknowledgePayments: true } : {}) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      // FIX (section-11/12 fix round): the void route now reports whether the
      // "this invoice is void" email actually reached the client (the Resend
      // SDK can reject a send without the request failing) — same pattern the
      // Send button above already surfaces via emailSent. Voiding still
      // succeeds either way; this just stops it from silently implying the
      // client was told when they weren't.
      if (json.clientNotified === false)
        alert('The invoice is now void, but the notification email to the client could not be delivered. You may want to let them know directly.')
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
        {paid > 0 && (
          <p className="ferr" style={{ marginBottom: 10 }}>
            {formatCurrencyExact(paid, invoice.currency)} has already been received on this invoice. Voiding keeps those payment records on file — you&apos;ll need to refund or credit the client separately.
          </p>
        )}
        {error && <p className="ferr" style={{ marginBottom: 10 }}>{error}</p>}
        <textarea className="finp" style={{ minHeight: 70, marginBottom: 14 }} value={reason}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
          placeholder={paid > 0 ? 'Reason for voiding (required — money was received)' : 'Optional: reason for voiding'} />
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
