'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'

type CoState = 'loading' | 'invalid' | 'revoked' | 'expired' | 'accepted' | 'declined' | 'withdrawn' | 'ready' | 'done'
type CoMode  = 'view' | 'accept' | 'decline' | 'counter'

interface CoData {
  id:          string
  title:       string
  note:        string | null
  projectName: string
  agencyName:  string
  brandColour: string
  logoUrl:     string | null
  lineItems:   Array<{ id: string; description: string; quantity: number; rate: number; total: number }>
  subtotal:    number
  taxRate:     number
  taxInclusive: boolean
  total:       number
  currency:    string
  clientName:  string
  version:     number
  expiresAt:   string
}

export default function CoPortalPage() {
  const params   = useParams()
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

  useEffect(() => {
    fetch(`/api/portal/co/${token}`)
      .then(r => r.json())
      .then(json => {
        if (json.state) { setState(json.state as CoState); return }
        setCo(json.co); setState('ready')
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
      setDoneMsg(json.message || 'Done')
      setState('done')
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

  const PortalShell = ({ children }: { children: React.ReactNode }) => (
    <div className="portal-root">
      <div className="portal-header">
        <div className="portal-header-brand" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {co?.logoUrl ? (
            <img src={co.logoUrl} alt={co.agencyName} style={{ height: 26, objectFit: 'contain' }} />
          ) : (
            <>
              <div style={{ width: 26, height: 26, background: accent, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="ti ti-scale" style={{ fontSize: 14, color: '#FFF' }} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{co?.agencyName || 'ScopeGov'}</span>
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

  if (state === 'loading') return <PortalShell><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><span className="spin spin-dark" style={{ width: 24, height: 24 }} /></div></PortalShell>

  const staticMsg: Record<string, { icon: string; iconBg: string; iconColor: string; title: string; body: string }> = {
    invalid:   { icon: 'ti-link-off', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'Link not found', body: 'This link is invalid or has expired. Please contact the agency.' },
    revoked:   { icon: 'ti-link-off', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'Link deactivated', body: 'This change order link is no longer active.' },
    expired:   { icon: 'ti-clock-off', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'Link expired', body: 'This link has expired. Please contact the agency for a new one.' },
    withdrawn: { icon: 'ti-file-off', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'CO withdrawn', body: 'The agency has withdrawn this change order.' },
    accepted:  { icon: 'ti-check', iconBg: '#EDFAF2', iconColor: '#1A5C3A', title: 'Already accepted', body: 'This change order has already been accepted. Thank you.' },
    declined:  { icon: 'ti-x', iconBg: '#FEF2F2', iconColor: '#B91C1C', title: 'Already declined', body: 'This change order has been declined.' },
  }

  if (staticMsg[state]) {
    const m = staticMsg[state]
    return (
      <PortalShell>
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
      <PortalShell>
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
    <PortalShell>
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

          <div className="portal-doc-body">
            {co.note && (
              <div style={{ marginBottom: 24 }}>
                <div className="portal-section-title">Context</div>
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
        {mode === 'view' && (
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
          </div>
        )}

        {mode === 'accept' && (
          <div className="portal-action-card" style={{ borderTopColor: accent }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontWeight: 400, margin: '0 0 6px' }}>Accept change order</h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
              Type your name to accept the additional scope and cost of <strong>{co.currency} {co.total.toLocaleString()}</strong>.
            </p>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 5, padding: '9px 12px', fontSize: 12, color: '#B91C1C', marginBottom: 12 }}>{error}</div>}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '.02em', color: '#555', marginBottom: 5 }}>Your full name</label>
              <input className="finp" value={signerName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSignerName(e.target.value)}
                placeholder="Type your full name to accept" autoFocus style={{ fontFamily: 'Georgia,serif', fontSize: 15 }} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" style={{ background: accent, color: '#FFF', padding: '10px 22px' }}
                onClick={() => submit('accept')} disabled={submitting || signerName.trim().length < 3}>
                {submitting ? <span className="spin" style={{ width: 14, height: 14 }} /> : `Accept as ${signerName || '…'}`}
              </button>
              <button className="btn btn-ghost" onClick={() => { setMode('view'); setError('') }}>Cancel</button>
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
                  placeholder={String(co.total)} min={0} autoFocus />
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
                disabled={submitting || !counterAmount || parseFloat(counterAmount) <= 0}>
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
