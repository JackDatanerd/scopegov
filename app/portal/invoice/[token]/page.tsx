'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'

type PortalState = 'loading' | 'error' | 'ready'

interface InvoiceData {
  id: string
  title: string
  amount: number
  amountPaid: number
  subtotal?: number | null
  taxRate?: number
  taxInclusive?: boolean
  currency: string
  status: string
  dueDate: string | null
  sentAt: string | null
  paymentInstructions: string | null
  invoiceNumber: string | null
  projectName: string
  clientName: string
  clientCompany: string | null
  agencyName: string
  brandColour: string
  logoUrl: string | null
}

interface Payment {
  amount: number
  paid_at: string
  method: string
  reference_note: string | null
}

const STATUS_LABEL: Record<string, { label: string; bg: string; fg: string }> = {
  sent:            { label: 'Awaiting payment', bg: '#FFF7ED', fg: '#B45309' },
  partially_paid:  { label: 'Partially paid',   bg: '#FFF7ED', fg: '#B45309' },
  paid:            { label: 'Paid in full',     bg: '#EDFAF2', fg: '#1A5C3A' },
  overdue:         { label: 'Overdue',          bg: '#FEF2F2', fg: '#B91C1C' },
}
const METHOD_LABEL: Record<string, string> = {
  bank_transfer: 'Bank transfer', stripe: 'Stripe', check: 'Check', cash: 'Cash', other: 'Other',
}

function fmtDate(d: string | null) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function InvoicePortalPage() {
  const params = useParams()
  const token  = params.token as string
  const [state, setState] = useState<PortalState>('loading')
  const [invoice, setInvoice] = useState<InvoiceData | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    fetch(`/api/portal/invoice/${token}`)
      .then(async r => {
        const json = await r.json()
        if (!r.ok) { setErrorMsg(json.error || 'Something went wrong'); setState('error'); return }
        setInvoice(json.invoice); setPayments(json.payments || []); setState('ready')
      })
      .catch(() => { setErrorMsg('Something went wrong'); setState('error') })
  }, [token])

  const accent = invoice?.brandColour || '#1A5C3A'
  const balanceDue = invoice ? Math.max(0, invoice.amount - invoice.amountPaid) : 0

  const PortalShell = ({ children }: { children: React.ReactNode }) => (
    <div className="portal-root">
      <div className="portal-header">
        <div className="portal-header-brand" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {invoice?.logoUrl ? (
            <img src={invoice.logoUrl} alt={invoice.agencyName} style={{ height: 26, objectFit: 'contain' }} />
          ) : (
            <>
              <div style={{ width: 26, height: 26, background: accent, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="ti ti-receipt" style={{ fontSize: 14, color: '#FFF' }} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{invoice?.agencyName || 'ScopeGov'}</span>
            </>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#909090', display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-lock" style={{ fontSize: 11 }} /> Secured by ScopeGov
        </div>
      </div>
      {children}
    </div>
  )

  if (state === 'loading') {
    return <PortalShell><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><span className="spin spin-dark" style={{ width: 24, height: 24 }} /></div></PortalShell>
  }

  if (state === 'error') {
    return (
      <PortalShell>
        <div style={{ textAlign: 'center', padding: '80px 32px' }}>
          <div style={{ width: 64, height: 64, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className="ti ti-link-off" style={{ fontSize: 28, color: '#B91C1C' }} />
          </div>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, margin: '0 0 10px' }}>Not available</h2>
          <p style={{ fontSize: 14, color: '#555', lineHeight: 1.7, maxWidth: 360, margin: '0 auto' }}>{errorMsg}</p>
        </div>
      </PortalShell>
    )
  }

  if (!invoice) return null
  const statusMeta = STATUS_LABEL[invoice.status] || { label: invoice.status, bg: '#F5F5F0', fg: '#666' }

  return (
    <PortalShell>
      <div className="portal-body">
        <div className="portal-doc-surface">
          <div className="portal-doc-head">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: '#909090', marginBottom: 6 }}>
                  Invoice{invoice.invoiceNumber ? ` · ${invoice.invoiceNumber}` : ''}
                </div>
                <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 24, fontWeight: 400, margin: '0 0 6px', letterSpacing: '-0.01em' }}>{invoice.title}</h1>
                <div style={{ fontSize: 13, color: '#555' }}>
                  <strong>{invoice.agencyName}</strong> → <strong>{invoice.clientCompany || invoice.clientName}</strong> · {invoice.projectName}
                </div>
                <span style={{ display: 'inline-block', marginTop: 10, fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 20, background: statusMeta.bg, color: statusMeta.fg }}>
                  {statusMeta.label}
                </span>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 24, fontFamily: 'Georgia,serif', color: accent, fontWeight: 400 }}>
                  {invoice.currency} {invoice.amount.toLocaleString()}
                </div>
                {invoice.dueDate && <div style={{ fontSize: 11, color: '#909090', marginTop: 2 }}>Due {fmtDate(invoice.dueDate)}</div>}
              </div>
            </div>
          </div>

          <div className="portal-doc-body">
            <div style={{ background: '#FAFAF6', border: '1px solid #F0F0EA', borderRadius: 6, padding: '14px 16px', marginBottom: 20 }}>
              {/* FIX (doc-completeness audit, finding #2): tax breakdown,
                  previously invisible everywhere including here. */}
              {(invoice.taxRate || 0) > 0 && invoice.subtotal != null && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#555', marginBottom: 6 }}>
                    <span>Subtotal</span>
                    <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{invoice.currency} {invoice.subtotal.toLocaleString()}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#555', marginBottom: 6 }}>
                    <span>Tax ({invoice.taxRate}%){invoice.taxInclusive ? ' — included' : ''}</span>
                    <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                      {invoice.taxInclusive ? '—' : `${invoice.currency} ${(invoice.amount - invoice.subtotal).toLocaleString()}`}
                    </span>
                  </div>
                </>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#555', marginBottom: invoice.amountPaid > 0 ? 6 : 0 }}>
                <span>Invoice amount</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{invoice.currency} {invoice.amount.toLocaleString()}</span>
              </div>
              {invoice.amountPaid > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#1A5C3A', marginBottom: 8 }}>
                  <span>Paid to date</span>
                  <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>-{invoice.currency} {invoice.amountPaid.toLocaleString()}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 600, paddingTop: invoice.amountPaid > 0 ? 8 : 0, borderTop: invoice.amountPaid > 0 ? '1px solid #E5E1D8' : 'none' }}>
                <span>{balanceDue > 0 ? 'Balance due' : 'Paid in full'}</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace', color: accent }}>{invoice.currency} {balanceDue.toLocaleString()}</span>
              </div>
            </div>

            {invoice.paymentInstructions && (
              <div style={{ marginBottom: 20 }}>
                <div className="portal-section-title">Payment instructions</div>
                <div className="portal-section-body" style={{ whiteSpace: 'pre-line' }}>{invoice.paymentInstructions}</div>
              </div>
            )}

            {payments.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div className="portal-section-title">Payments received</div>
                {payments.map((p, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: '#555', padding: '7px 0', borderBottom: '1px solid #F2F0EA' }}>
                    <span>{fmtDate(p.paid_at)} · {METHOD_LABEL[p.method] || p.method}{p.reference_note ? ` · ${p.reference_note}` : ''}</span>
                    <span style={{ fontFamily: 'IBM Plex Mono, monospace', color: '#333' }}>{invoice.currency} {p.amount.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="portal-action-card" style={{ borderTopColor: accent }}>
          <p style={{ fontSize: 12.5, color: '#909090', margin: '0 0 14px', lineHeight: 1.6 }}>
            This is a document, not a payment portal — pay per the instructions above, then the agency will
            mark it received. ScopeGov does not process this payment.
          </p>
          <a
            href={`/api/portal/invoice/${token}/pdf`}
            className="btn btn-ghost"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <i className="ti ti-download" style={{ fontSize: 13 }} /> Download PDF
          </a>
        </div>
      </div>
    </PortalShell>
  )
}
