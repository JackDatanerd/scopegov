'use client'
import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import SignaturePad, { type SignaturePadHandle } from '@/components/ui/SignaturePad'
import PortalShell from '@/components/portal/PortalShell'

type CoState = 'loading' | 'invalid' | 'revoked' | 'expired' | 'accepted' | 'declined' | 'withdrawn' | 'closed' | 'stalled' | 'countered' | 'ready' | 'done'
type CoMode  = 'view' | 'accept' | 'decline' | 'counter'

interface CoData {
  id:          string
  title:       string
  note:        string | null
  mode:        'respond' | 'countersign'
  projectName: string
  agencyName:  string
  brandColour: string
  logoUrl:     string | null
  agencyAddress: string | null
  agencyTaxId:   string | null
  agencyPhone:   string | null
  agencyWebsite: string | null
  agencySignatureData: string | null
  lineItems:   Array<{ id: string; description: string; quantity: number; rate: number; total: number }>
  subtotal:    number
  taxRate:     number
  taxInclusive: boolean
  total:       number
  currency:    string
  clientName:  string
  clientCompany: string | null
  clientBillingAddress: string | null
  clientVatNumber:      string | null
  version:     number
  expiresAt:   string
}

export default function CoPortalPage() {
  const params   = useParams()
  const router    = useRouter()
  const token    = params.token as string
  const [state,  setState]  = useState<CoState>('loading')
  const [co,     setCo]     = useState<CoData | null>(null)
  const [mode,   setMode]   = useState<CoMode>('view')
  const [signerName,     setSignerName]     = useState('')
  const [declineReason,  setDeclineReason]  = useState('')
  const [counterAmount,  setCounterAmount]  = useState('')
  const [counterNote,    setCounterNote]    = useState('')
  const [doneMsg, setDoneMsg] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error,  setError]  = useState('')
  const [acceptedInfo, setAcceptedInfo] = useState<{ acceptedBy: string | null; clientSignatureData: string | null } | null>(null)
  const sigPadRef = useRef<SignaturePadHandle>(null)

  useEffect(() => {
    fetch(`/api/portal/co/${token}`)
      .then(r => r.json())
      .then(json => {
        if (json.state) {
          setState(json.state as CoState)
          if (json.state === 'accepted') setAcceptedInfo({ acceptedBy: json.acceptedBy, clientSignatureData: json.clientSignatureData })
          return
        }
        setCo(json.co); setState('ready')
        // FIX (doc-completeness audit, migration 014): a CO awaiting
        // countersignature skips the "how would you like to respond"
        // choice — the negotiation is over, this step is just capturing
        // the client's signature on the agreed amount.
        if (json.co?.mode === 'countersign') setMode('accept')
      })
      .catch(() => setState('invalid'))
  }, [token])

  async function submit(action: string, extra?: Record<string, unknown>) {
    setSubmitting(true); setError('')
    try {
      const res  = await fetch(`/api/portal/co/${token}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerName, ...extra }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      if (action === 'accept' || action === 'countersign') setAcceptedInfo({ acceptedBy: signerName.trim(), clientSignatureData: (extra?.signatureData as string) || null })
      setDoneMsg(json.message || 'Done')
      setState('done')
      // FIX (re-audit, portal section): accept/countersign both reissue a
      // fresh, long-lived token (see finalize-co.ts) — swap the URL to it
      // so a refresh or a bookmark of this page keeps working past the
      // original signing link's short expiry, matching the SOW portal
      // page's equivalent fix.
      if ((action === 'accept' || action === 'countersign') && json.token && json.token !== token) {
        router.replace(`/portal/co/${json.token}`)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally { setSubmitting(false) }
  }

  const accent = co?.brandColour || '#1A5C3A'
  const taxLine = co
    ? co.taxInclusive
      ? `Tax included in total (${co.taxRate}%)`
      : co.taxRate > 0
        ? `Tax: ${co.currency} ${(co.subtotal * co.taxRate / 100).toLocaleString()}`
        : null
    : null

  if (state === 'loading') return <PortalShell logoUrl={co?.logoUrl} agencyName={co?.agencyName} accent={accent} icon="ti-scale"><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><span className="spin spin-dark" style={{ width: 24, height: 24 }} /></div></PortalShell>

  const staticMsg: Record<string, { icon: string; iconBg: string; iconColor: string; title: string; body: string }> = {
    invalid:   { icon: 'ti-link-off', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'Link not found', body: 'This link is invalid or has expired. Please contact the agency.' },
    revoked:   { icon: 'ti-link-off', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'Link deactivated', body: 'This change order link is no longer active.' },
    expired:   { icon: 'ti-clock-off', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'Link expired', body: 'This link has expired. Please contact the agency for a new one.' },
    withdrawn: { icon: 'ti-file-off', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'CO withdrawn', body: 'The agency has withdrawn this change order.' },
    declined:  { icon: 'ti-x', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'Already declined', body: 'This change order has been declined.' },
    closed:    { icon: 'ti-lock', iconBg: '#F5F5F0', iconColor: '#666', title: 'No longer available', body: 'This change order has been closed by the agency and is no longer open for a response.' },
    stalled:   { icon: 'ti-clock-off', iconBg: '#FFF7ED', iconColor: '#B45309', title: 'Link inactive', body: 'This change order received no response in time and is now inactive. Please contact the agency for an updated request.' },
    countered: { icon: 'ti-check', iconBg: '#EDFAF2', iconColor: '#1A5C3A', title: 'Counter already sent', body: 'You have already sent a counter-offer for this change order. The agency has been notified and will respond soon.' },
  }

  if (state === 'accepted') {
    return (
      <PortalShell logoUrl={co?.logoUrl} agencyName={co?.agencyName} accent={accent} icon="ti-scale">
        <div style={{ textAlign: 'center', padding: '80px 32px' }}>
          <div style={{ width: 64, height: 64, background: '#EDFAF2', border: '1px solid #B7DCC8', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className="ti ti-check" style={{ fontSize: 28, color: '#1A5C3A' }} />
          </div>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, margin: '0 0 10px' }}>Already accepted</h2>
          <p style={{ fontSize: 14, color: '#555', lineHeight: 1.7, maxWidth: 360, margin: '0 auto' }}>
            This change order has already been accepted{acceptedInfo?.acceptedBy ? ` by ${acceptedInfo.acceptedBy}` : ''}. Thank you.
          </p>
          {acceptedInfo?.clientSignatureData && (
            <div style={{ display: 'inline-block', background: '#fff', border: '1px solid #E5E5E0', borderRadius: 6, padding: '14px 22px', marginTop: 24 }}>
              <img src={acceptedInfo.clientSignatureData} alt="Signature" style={{ height: 56, display: 'block', margin: '0 auto' }} />
            </div>
          )}
          {/* FIX (audit): /api/portal/co/[token]/pdf already existed and worked —
              it was only ever used as an email attachment link. Clients had no
              self-service way to re-download the accepted CO from this page. */}
          <a href={`/api/portal/co/${token}/pdf`} className="btn btn-ghost btn-sm"
             style={{ display: 'inline-flex', marginTop: 20 }}>
            <i className="ti ti-download" style={{ fontSize: 14, marginRight: 6 }} /> Download PDF
          </a>
        </div>
      </PortalShell>
    )
  }

  if (staticMsg[state]) {
    const m = staticMsg[state]
    return (
      <PortalShell logoUrl={co?.logoUrl} agencyName={co?.agencyName} accent={accent} icon="ti-scale">
        <div style={{ textAlign: 'center', padding: '80px 32px' }}>
          <div style={{ width: 64, height: 64, background: m.iconBg, border: `1px solid ${m.iconColor}40`, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className={`ti ${m.icon}`} style={{ fontSize: 28, color: m.iconColor }} />
          </div>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, margin: '0 0 10px' }}>{m.title}</h2>
          <p style={{ fontSize: 14, color: '#555', lineHeight: 1.7, maxWidth: 360, margin: '0 auto' }}>{m.body}</p>
        </div>
      </PortalShell>
    )
  }

  if (state === 'done') {
    return (
      <PortalShell logoUrl={co?.logoUrl} agencyName={co?.agencyName} accent={accent} icon="ti-scale">
        <div style={{ textAlign: 'center', padding: '80px 32px' }}>
          <div style={{ width: 64, height: 64, background: '#EDFAF2', border: '1px solid #B7DCC8', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className="ti ti-check" style={{ fontSize: 28, color: '#1A5C3A' }} />
          </div>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, margin: '0 0 10px' }}>Response submitted</h2>
          <p style={{ fontSize: 14, color: '#555', lineHeight: 1.7, maxWidth: 360, margin: '0 auto' }}>{doneMsg}</p>
        </div>
      </PortalShell>
    )
  }

  if (!co) return null

  return (
    <PortalShell logoUrl={co?.logoUrl} agencyName={co?.agencyName} accent={accent} icon="ti-scale">
      <div className="portal-body">
        {/* CO Document */}
        <div className="portal-doc-surface">
          <div className="portal-doc-head">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: '#909090', marginBottom: 6 }}>
                  Change Order · v{co.version}
                </div>
                <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 24, fontWeight: 400, margin: '0 0 6px', letterSpacing: '-0.01em' }}>{co.title}</h1>
                <div style={{ fontSize: 13, color: '#555' }}>
                  <strong>{co.agencyName}</strong> → <strong>{co.clientName}</strong> · {co.projectName}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 24, fontFamily: 'Georgia,serif', color: accent, fontWeight: 400 }}>
                  {co.currency} {co.total.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: '#909090', marginTop: 2 }}>Additional scope cost</div>
              </div>
            </div>
          </div>

          {/* Parties — FIX (doc-completeness audit): previously missing
              from this page entirely, same gap as the SOW portal. */}
          <div className="portal-doc-body" style={{ paddingBottom: 0 }}>
            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid #E5E1D8' }}>
              <div style={{ flex: '1 1 220px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#909090', marginBottom: 6 }}>
                  Agency (Service Provider)
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1A1A1A' }}>{co.agencyName}</div>
                {co.agencyAddress && <div style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-line', marginTop: 2 }}>{co.agencyAddress}</div>}
                {(co.agencyTaxId || co.agencyPhone || co.agencyWebsite) && (
                  <div style={{ fontSize: 11, color: '#909090', marginTop: 4 }}>
                    {[co.agencyTaxId ? `Tax ID ${co.agencyTaxId}` : null, co.agencyPhone, co.agencyWebsite].filter(Boolean).join('  ·  ')}
                  </div>
                )}
              </div>
              <div style={{ flex: '1 1 220px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#909090', marginBottom: 6 }}>
                  Client
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1A1A1A' }}>{co.clientCompany || co.clientName}</div>
                {co.clientCompany && <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{co.clientName}</div>}
                {co.clientBillingAddress && <div style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-line', marginTop: 2 }}>{co.clientBillingAddress}</div>}
                {co.clientVatNumber && <div style={{ fontSize: 11, color: '#909090', marginTop: 4 }}>VAT {co.clientVatNumber}</div>}
              </div>
            </div>
          </div>

          <div className="portal-doc-body" style={{ paddingTop: 0 }}>
            {co.note && (
              <div style={{ marginBottom: 24 }}>
                <div className="portal-section-title">Context</div>
                {/* FIX (doc-quality audit round 3): co.note is now a
                    Tiptap-authored rich text field (components/co/
                    CoEditor.tsx via RichTextField), sanitized server-side
                    at write time with sanitizeRichTextOrNull (see
                    lib/utils/sanitize.ts) before it ever reaches this
                    public, unauthenticated page — same guarantee SOW
                    section content already has. Safe to render as HTML
                    now; the plain-text pre-wrap workaround from the prior
                    audit round no longer applies. */}
                <div className="portal-section-body" dangerouslySetInnerHTML={{ __html: co.note }} />
              </div>
            )}

            {/* Line items */}
            <div>
              <div className="portal-section-title">Scope additions</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '8px 0', borderBottom: '1px solid #E5E1D8', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#909090' }}>Description</th>
                    <th style={{ textAlign: 'center', padding: '8px 12px', borderBottom: '1px solid #E5E1D8', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#909090', width: 60 }}>Qty</th>
                    <th style={{ textAlign: 'right', padding: '8px 0', borderBottom: '1px solid #E5E1D8', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#909090', width: 100 }}>Rate</th>
                    <th style={{ textAlign: 'right', padding: '8px 0', borderBottom: '1px solid #E5E1D8', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#909090', width: 100 }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {co.lineItems.map((item) => (
                    <tr key={item.id}>
                      <td style={{ padding: '11px 0', borderBottom: '1px solid #F2F0EA', color: '#333', lineHeight: 1.5 }}>{item.description}</td>
                      <td style={{ padding: '11px 12px', borderBottom: '1px solid #F2F0EA', textAlign: 'center', color: '#555' }}>{item.quantity}</td>
                      <td style={{ padding: '11px 0', borderBottom: '1px solid #F2F0EA', textAlign: 'right', fontFamily: 'IBM Plex Mono, monospace', color: '#555' }}>{co.currency} {item.rate.toLocaleString()}</td>
                      <td style={{ padding: '11px 0', borderBottom: '1px solid #F2F0EA', textAlign: 'right', fontFamily: 'IBM Plex Mono, monospace', color: '#333', fontWeight: 500 }}>{co.currency} {item.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #E5E1D8' }}>
                {co.taxRate > 0 && !co.taxInclusive && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#555', marginBottom: 4 }}>
                    <span>Tax ({co.taxRate}%)</span>
                    <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{co.currency} {(co.subtotal * co.taxRate / 100).toLocaleString()}</span>
                  </div>
                )}
                {co.taxInclusive && co.taxRate > 0 && (
                  <div style={{ fontSize: 11, color: '#909090', marginBottom: 4 }}>Tax included ({co.taxRate}%)</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 600 }}>
                  <span>Total</span>
                  <span style={{ fontFamily: 'IBM Plex Mono, monospace', color: accent }}>{co.currency} {co.total.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Action card */}
        {mode === 'view' && co.mode !== 'countersign' && (
          <div className="portal-action-card" style={{ borderTopColor: accent }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontWeight: 400, margin: '0 0 6px' }}>How would you like to respond?</h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 18px', lineHeight: 1.6 }}>
              Review the scope additions above. Accept to confirm the work and value,
              propose a counter if you&apos;d like to negotiate, or decline to reject this change order.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn" style={{ background: accent, color: '#FFF', padding: '10px 22px', fontWeight: 600 }} onClick={() => setMode('accept')}>
                <i className="ti ti-check" style={{ fontSize: 13 }} /> Accept
              </button>
              <button className="btn btn-ghost" onClick={() => setMode('counter')}>Propose counter</button>
              <button className="btn btn-ghost" style={{ color: '#B91C1C', borderColor: '#FECACA' }} onClick={() => setMode('decline')}>Decline</button>
            </div>
            {/* FIX (re-audit, portal section): co.expiresAt was fetched
                into CoData but never rendered anywhere — the sibling SOW
                portal page shows this same field. Without it the client
                has no warning before their link goes dead. */}
            <p style={{ fontSize: 11, color: '#B0B0B0', marginTop: 14 }}>
              This link expires {new Date(co.expiresAt).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}.
            </p>
          </div>
        )}

        {mode === 'accept' && (
          <div className="portal-action-card" style={{ borderTopColor: accent }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontWeight: 400, margin: '0 0 6px' }}>
              {co.mode === 'countersign' ? 'Confirm change order' : 'Accept change order'}
            </h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
              {co.mode === 'countersign'
                ? <>{co.agencyName} has accepted your proposed amount. Type your name, draw your signature, and confirm the change order at <strong>{co.currency} {co.total.toLocaleString()}</strong>.</>
                : <>Type your name, draw your signature, and accept the additional scope and cost of <strong>{co.currency} {co.total.toLocaleString()}</strong>.</>}
            </p>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 5, padding: '9px 12px', fontSize: 12, color: '#B91C1C', marginBottom: 12 }}>{error}</div>}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '.02em', color: '#555', marginBottom: 5 }}>Your full name</label>
              <input className="finp" value={signerName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSignerName(e.target.value)}
                placeholder="Type your full name to accept" autoFocus style={{ fontFamily: 'Georgia,serif', fontSize: 15 }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <label style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.02em', color: '#555' }}>Draw your signature</label>
                <button type="button" onClick={() => sigPadRef.current?.clear()}
                  style={{ background: 'none', border: 'none', fontSize: 11, color: '#909090', cursor: 'pointer', textDecoration: 'underline' }}>Clear</button>
              </div>
              <SignaturePad ref={sigPadRef} strokeColour={accent} height={140} />
            </div>
            {co.agencySignatureData && (
              <div style={{ marginBottom: 16, padding: '10px 14px', background: '#FAFAF6', border: '1px solid #F0F0EA', borderRadius: 5 }}>
                <div style={{ fontSize: 10.5, color: '#909090', marginBottom: 4 }}>Already signed by {co.agencyName}</div>
                <img src={co.agencySignatureData} alt={`${co.agencyName} signature`} style={{ height: 30 }} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" style={{ background: accent, color: '#FFF', padding: '10px 22px' }}
                onClick={() => {
                  const signatureData = sigPadRef.current?.toDataURL()
                  if (!signatureData) { setError('Please draw your signature to accept.'); return }
                  submit(co.mode === 'countersign' ? 'countersign' : 'accept', { signatureData })
                }}
                disabled={submitting || signerName.trim().length < 3}>
                {submitting ? <span className="spin" style={{ width: 14, height: 14 }} /> : `${co.mode === 'countersign' ? 'Confirm' : 'Accept'} as ${signerName || '…'}`}
              </button>
              {co.mode !== 'countersign' && (
                <button className="btn btn-ghost" onClick={() => { setMode('view'); setError('') }}>Cancel</button>
              )}
            </div>
          </div>
        )}

        {mode === 'counter' && (
          <div className="portal-action-card" style={{ borderTopColor: '#B45309' }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontWeight: 400, margin: '0 0 6px' }}>Propose counter offer</h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
              Suggest a different amount. The agency will review your counter and respond.
            </p>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 5, padding: '9px 12px', fontSize: 12, color: '#B91C1C', marginBottom: 12 }}>{error}</div>}
            <div className="f2" style={{ marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 5 }}>Counter amount ({co.currency})</label>
                <input type="number" className="finp" value={counterAmount}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCounterAmount(e.target.value)}
                  placeholder={String(co.total)} min={0} step="0.01" autoFocus />
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 5 }}>Note <span style={{ fontWeight: 400, color: '#909090' }}>— explain your reasoning</span></label>
              <textarea className="finp" style={{ minHeight: 80 }} value={counterNote}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCounterNote(e.target.value)}
                placeholder="Why are you proposing this amount?" />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" style={{ background: '#B45309', color: '#FFF', padding: '10px 22px' }}
                onClick={() => submit('counter', { counterAmount: parseFloat(counterAmount), counterNote })}
                // FIX (deep audit, section 18 follow-up): `parseFloat(counterAmount) <= 0`
                // is false for a non-numeric value like "abc" (NaN <= 0 is
                // false), so this button stayed enabled and silently sent
                // NaN (which JSON.stringify turns into null) — the server
                // already rejects it correctly, but the button gave no
                // client-side signal anything was wrong. Number.isFinite
                // closes that hole the same way the server-side check does.
                disabled={submitting || !counterAmount || !Number.isFinite(parseFloat(counterAmount)) || parseFloat(counterAmount) <= 0}>
                {submitting ? <span className="spin" style={{ width: 14, height: 14 }} /> : 'Submit counter offer'}
              </button>
              <button className="btn btn-ghost" onClick={() => { setMode('view'); setError('') }}>Cancel</button>
            </div>
          </div>
        )}

        {mode === 'decline' && (
          <div className="portal-action-card" style={{ borderTopColor: '#B91C1C' }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontWeight: 400, margin: '0 0 6px' }}>Decline change order</h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>You can optionally share your reason. The agency will be notified.</p>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 5, padding: '9px 12px', fontSize: 12, color: '#B91C1C', marginBottom: 12 }}>{error}</div>}
            <textarea className="finp" style={{ minHeight: 72, marginBottom: 14 }} value={declineReason}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDeclineReason(e.target.value)}
              placeholder="Optional: reason for declining" />
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-danger" style={{ padding: '10px 22px' }}
                onClick={() => submit('decline', { reason: declineReason })} disabled={submitting}>
                {submitting ? <span className="spin" style={{ width: 14, height: 14, borderColor: 'rgba(185,28,28,.2)', borderTopColor: '#B91C1C' }} /> : 'Decline'}
              </button>
              <button className="btn btn-ghost" onClick={() => { setMode('view'); setError('') }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </PortalShell>
  )
}
