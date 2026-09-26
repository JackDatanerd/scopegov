'use client'
import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import SignaturePad, { type SignaturePadHandle } from '@/components/ui/SignaturePad'
import { isTableSection, SOW_TABLE_SCHEMAS, columnLabel, type SowTableSectionId, type SowTableRow } from '@/lib/sow/table-schema'
// FIX (deep audit, client-facing/signing section): this page formatted money with raw
// .toLocaleString() — no minimumFractionDigits, so a figure with cents (1234.50) could print as
// "1,234.5", and one without (1500.00) as "1,500" — inconsistent, and on a contract figure reads
// as a typo. formatAmount already exists for exactly this (see its own comment) and is already
// used by every email and the PDF renderer; this page — the actual document the client signs —
// never adopted it, so the amount they see here could visibly disagree with the amount on the PDF
// of the same document.
import { formatAmount } from '@/lib/utils/money'

type PortalState =
  | 'loading' | 'invalid' | 'revoked' | 'expired' | 'declined'
  | 'withdrawn' | 'signed' | 'ready' | 'signing' | 'requesting' | 'declining'
  | 'changes_requested'

interface PaymentScheduleItem {
  title: string
  amount: number | null
  percentage: number | null
  trigger: string | null
  dueDate: string | null
  status: string
}

interface SowData {
  id:          string
  projectName: string
  agencyName:  string
  brandColour: string
  logoUrl:     string | null
  agencyAddress: string | null
  agencyTaxId:   string | null
  agencyPhone:   string | null
  agencyWebsite: string | null
  agencySignatureData: string | null
  contractValue: number
  currency:    string
  // Drafting language, for localized table headers (9-G7).
  language?:   string
  clientName:  string
  clientEmail: string
  clientCompany: string | null
  clientBillingAddress: string | null
  clientVatNumber:      string | null
  sections:    Array<{ id: string; title: string; content: string; table?: SowTableRow[]; visible: boolean; order: number }>
  paymentSchedule: PaymentScheduleItem[]
  version:     number
  expiresAt:   string
}

export default function SowPortalPage() {
  const params      = useParams()
  const router       = useRouter()
  const token       = params.token as string
  const [state,     setState]     = useState<PortalState>('loading')
  const [sow,       setSow]       = useState<SowData | null>(null)
  const [mode,      setMode]      = useState<'view' | 'sign' | 'changes' | 'decline'>('view')
  const [signerName, setSignerName] = useState('')
  const [agreed,    setAgreed]    = useState(false)
  const [changesNote, setChangesNote] = useState('')
  const [declineReason, setDeclineReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error,     setError]     = useState('')
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const [signedInfo, setSignedInfo] = useState<{ signedBy: string | null; clientSignatureData: string | null } | null>(null)
  const [sigEmpty,  setSigEmpty]  = useState(true)
  const sigPadRef = useRef<SignaturePadHandle>(null)

  useEffect(() => {
    fetch(`/api/portal/sow/${token}`)
      .then(r => r.json())
      .then(json => {
        if (json.state) {
          setState(json.state as PortalState)
          if (json.state === 'signed') setSignedInfo({ signedBy: json.signedBy, clientSignatureData: json.clientSignatureData })
          return
        }
        setSow(json.sow)
        setState('ready')
        if (json.sow.sections?.[0]) setActiveSection(json.sow.sections[0].id)
      })
      .catch(() => setState('invalid'))
  }, [token])

  async function handleSign() {
    if (!signerName || signerName.trim().length < 3) {
      setError('Please enter your full name to sign.')
      return
    }
    if (!agreed) { setError('Please confirm you have read and agree to the terms.'); return }
    const signatureData = sigPadRef.current?.toDataURL()
    if (!signatureData) { setError('Please draw your signature to sign.'); return }
    setSubmitting(true); setError('')
    try {
      const res  = await fetch(`/api/portal/sow/${token}/sign`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ signerName: signerName.trim(), signatureData }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setSignedInfo({ signedBy: signerName.trim(), clientSignatureData: signatureData })
      setState('signed')
      // FIX (re-audit, portal section): the sign route reissues a fresh,
      // long-lived token for post-signature access (see sign/route.ts) and
      // returns it here — swap the URL to it via replace (no new history
      // entry) so a refresh or a bookmark of this page keeps working past
      // the original signing link's short expiry window, instead of 404ing
      // the moment the client revisits their own executed document later.
      if (json.token && json.token !== token) {
        router.replace(`/portal/sow/${json.token}`)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally { setSubmitting(false) }
  }

  async function handleRequestChanges() {
    if (changesNote.trim().length < 20) {
      setError('Please describe the changes needed (at least 20 characters).')
      return
    }
    setSubmitting(true); setError('')
    try {
      const res  = await fetch(`/api/portal/sow/${token}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ note: changesNote.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setState('requesting' as any)
      setMode('view')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally { setSubmitting(false) }
  }

  async function handleDecline() {
    setSubmitting(true); setError('')
    try {
      const res  = await fetch(`/api/portal/sow/${token}/decline`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reason: declineReason.trim() || null }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setState('declined')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally { setSubmitting(false) }
  }

  const accent = sow?.brandColour || '#1A5C3A'
  // FIX (section-9 re-pass): lib/pdf/renderer.tsx deliberately excludes
  // 'parties' and 'signature' from its generic section loop because both
  // are already shown via dedicated blocks (the PDF's own Parties box
  // and signature lines). This page built the equivalent Agency/Client
  // info box (below) and has its own interactive "Sign this agreement"
  // action card, for the same reason — but never applied the matching
  // exclusion, so the 'parties' section's boilerplate text ("This SOW is
  // entered into between Agency and Client") printed a second time,
  // restating the info box directly above it.
  const visibleSections = sow?.sections
    .filter(s => s.visible && !['parties', 'signature'].includes(s.id))
    .sort((a, b) => a.order - b.order) || []
  // The Parties and Signature sections are excluded from the generic loop (their data-driven blocks
  // replace the boilerplate heading), but the TEXT the agency wrote in them — the "entered into
  // between…" preamble and the "by signing below, both parties agree…" clause — is part of the
  // agreement and must reach the signer. Rendered once, in place. Content is sanitised server-side.
  const hasText = (html?: string) => !!html && html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0
  const partiesProse   = sow?.sections.find(s => s.id === 'parties' && s.visible && hasText(s.content))?.content || ''
  const signatureProse = sow?.sections.find(s => s.id === 'signature' && s.visible && hasText(s.content))?.content || ''

  // ── Static states ─────────────────────────────────────────
  if (state === 'loading') return <PortalShell><Loading /></PortalShell>

  if (['invalid','revoked','expired','withdrawn'].includes(state)) {
    const messages: Record<string, { icon: string; title: string; body: string }> = {
      invalid:   { icon: 'ti-link-off',    title: 'Link not found',   body: 'This link is invalid or has expired. Please contact the agency for a fresh link.' },
      revoked:   { icon: 'ti-link-off',    title: 'Link deactivated', body: 'This agreement link is no longer active. Please contact the agency for more information.' },
      expired:   { icon: 'ti-clock-off',   title: 'Link expired',     body: 'This signing link has expired. Please contact the agency to request a new one.' },
      withdrawn: { icon: 'ti-file-off',    title: 'SOW withdrawn',    body: 'The agency has withdrawn this Statement of Work. Please contact them for an updated agreement.' },
    }
    const msg = messages[state] || messages.invalid
    return (
      <PortalShell>
        <div style={{ textAlign: 'center', padding: '80px 32px' }}>
          <div style={{ width: 64, height: 64, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className={`ti ${msg.icon}`} style={{ fontSize: 28, color: '#B91C1C' }} />
          </div>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, margin: '0 0 10px' }}>{msg.title}</h2>
          <p style={{ fontSize: 14, color: '#555', lineHeight: 1.7, maxWidth: 360, margin: '0 auto' }}>{msg.body}</p>
        </div>
      </PortalShell>
    )
  }

  if (state === 'signed' || (state as string) === 'requesting' || (state as string) === 'changes_requested') {
    return (
      <PortalShell accent={accent} agencyName={sow?.agencyName}>
        <div style={{ textAlign: 'center', padding: '80px 32px' }}>
          <div style={{ width: 64, height: 64, background: '#EDFAF2', border: '1px solid #B7DCC8', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className={`ti ${state === 'signed' ? 'ti-check' : 'ti-send'}`} style={{ fontSize: 28, color: '#1A5C3A' }} />
          </div>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, margin: '0 0 10px' }}>
            {state === 'signed' ? 'Agreement signed' : 'Changes requested'}
          </h2>
          <p style={{ fontSize: 14, color: '#555', lineHeight: 1.7, maxWidth: 360, margin: '0 auto' }}>
            {state === 'signed'
              ? `Thank you${signedInfo?.signedBy ? `, ${signedInfo.signedBy}` : ''}. Your signed copy will be emailed to you. The team at ${sow?.agencyName} has been notified.`
              : 'Your feedback has been sent. The team will review your notes and send an updated agreement.'}
          </p>
          {state === 'signed' && signedInfo?.clientSignatureData && (
            <div style={{ display: 'inline-block', background: '#fff', border: '1px solid #E5E5E0', borderRadius: 6, padding: '14px 22px', marginTop: 24 }}>
              <img src={signedInfo.clientSignatureData} alt="Your signature" style={{ height: 56, display: 'block', margin: '0 auto' }} />
              <div style={{ fontSize: 11, color: '#909090', marginTop: 8, borderTop: '1px solid #F0F0EA', paddingTop: 6 }}>{signedInfo.signedBy}</div>
            </div>
          )}
          {/* FIX (audit): no client-facing SOW PDF route existed at all —
              clients had no self-service way to get a copy of the signed
              agreement outside of the one-time email. */}
          {state === 'signed' && (
            <a href={`/api/portal/sow/${token}/pdf`} className="btn btn-ghost btn-sm"
               style={{ display: 'inline-flex', marginTop: 20 }}>
              <i className="ti ti-download" style={{ fontSize: 14, marginRight: 6 }} /> Download PDF
            </a>
          )}
        </div>
      </PortalShell>
    )
  }

  if (state === 'declined') {
    return (
      <PortalShell accent={accent} agencyName={sow?.agencyName}>
        <div style={{ textAlign: 'center', padding: '80px 32px' }}>
          <div style={{ width: 64, height: 64, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className="ti ti-x" style={{ fontSize: 28, color: '#B91C1C' }} />
          </div>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, margin: '0 0 10px' }}>Agreement declined</h2>
          <p style={{ fontSize: 14, color: '#555', lineHeight: 1.7, maxWidth: 360, margin: '0 auto' }}>
            You have declined this Statement of Work. {sow?.agencyName} has been notified.
          </p>
        </div>
      </PortalShell>
    )
  }

  if (!sow) return null

  return (
    <PortalShell accent={accent} agencyName={sow.agencyName} logoUrl={sow.logoUrl}>
      <div className="portal-body">
        {/* Document header */}
        <div className="portal-doc-surface">
          <div className="portal-doc-head">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: '#909090', marginBottom: 6 }}>
                  Statement of Work · v{sow.version}
                </div>
                <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 24, fontWeight: 400, margin: '0 0 6px', letterSpacing: '-0.01em' }}>
                  {sow.projectName}
                </h1>
                <div style={{ fontSize: 13, color: '#555' }}>
                  Prepared by <strong>{sow.agencyName}</strong> for <strong>{sow.clientName}</strong>
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 22, fontFamily: 'Georgia,serif', color: accent, fontWeight: 400 }}>
                  {sow.currency} {formatAmount(sow.contractValue, sow.currency)}
                </div>
                <div style={{ fontSize: 11, color: '#909090', marginTop: 2 }}>Contract value</div>
                {/* A watermarked, unsigned copy for the signer's own review (counsel, finance).
                    Until now the PDF was only available after signing. */}
                <a href={`/api/portal/sow/${token}/pdf`} style={{ display: 'inline-block', marginTop: 10, fontSize: 12, color: accent }}>
                  <i className="ti ti-download" style={{ fontSize: 13, marginRight: 4 }} />Download a copy to review (PDF)
                </a>
              </div>
            </div>
          </div>

          {/* Parties — FIX (doc-completeness audit): this block, plus the
              payment schedule below, previously didn't exist on this page
              at all, so the client signed without ever seeing the legal
              addresses, tax IDs, or payment schedule that the PDF (only
              generated after signing) already included. */}
          <div className="portal-doc-body" style={{ paddingBottom: 0 }}>
            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid #E5E1D8' }}>
              <div style={{ flex: '1 1 220px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#909090', marginBottom: 6 }}>
                  Agency (Service Provider)
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1A1A1A' }}>{sow.agencyName}</div>
                {sow.agencyAddress && <div style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-line', marginTop: 2 }}>{sow.agencyAddress}</div>}
                {(sow.agencyTaxId || sow.agencyPhone || sow.agencyWebsite) && (
                  <div style={{ fontSize: 11, color: '#909090', marginTop: 4 }}>
                    {[sow.agencyTaxId ? `Tax ID ${sow.agencyTaxId}` : null, sow.agencyPhone, sow.agencyWebsite].filter(Boolean).join('  ·  ')}
                  </div>
                )}
              </div>
              <div style={{ flex: '1 1 220px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#909090', marginBottom: 6 }}>
                  Client
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1A1A1A' }}>{sow.clientCompany || sow.clientName}</div>
                {sow.clientCompany && <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{sow.clientName}</div>}
                {sow.clientBillingAddress && <div style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-line', marginTop: 2 }}>{sow.clientBillingAddress}</div>}
                {sow.clientVatNumber && <div style={{ fontSize: 11, color: '#909090', marginTop: 4 }}>VAT {sow.clientVatNumber}</div>}
              </div>
            </div>
          </div>

          {partiesProse && (
            <div className="portal-doc-body" style={{ paddingTop: 0, paddingBottom: 0 }}>
              <div className="portal-section-body" style={{ fontSize: 14, color: '#333', lineHeight: 1.75, marginBottom: 24 }}
                dangerouslySetInnerHTML={{ __html: partiesProse }} />
            </div>
          )}

          {sow.paymentSchedule.length > 0 && (
            <div className="portal-doc-body" style={{ paddingTop: 0, paddingBottom: 0 }}>
              <div style={{ marginBottom: 24 }}>
                <div className="portal-section-title">Payment schedule</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
                  <tbody>
                    {sow.paymentSchedule.map((m, i) => (
                      <tr key={i}>
                        <td style={{ padding: '8px 0', borderBottom: '1px solid #F2F0EA', color: '#333' }}>
                          {m.title}
                          {m.dueDate && <span style={{ color: '#909090', fontSize: 11 }}> · due {new Date(m.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
                          {!m.dueDate && m.trigger && <span style={{ color: '#909090', fontSize: 11 }}> · {m.trigger}</span>}
                        </td>
                        <td style={{ padding: '8px 0', borderBottom: '1px solid #F2F0EA', textAlign: 'right', fontFamily: 'IBM Plex Mono, monospace', color: '#333' }}>
                          {m.amount != null ? `${sow.currency} ${formatAmount(m.amount, sow.currency)}` : m.percentage != null ? `${m.percentage}%` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Sections — Deliverables/Timeline/Roles render as tables
              (same schema the PDF and editor use), matching what the
              signer will see on the downloaded document. */}
          <div className="portal-doc-body">
            {visibleSections.map((section) => (
              <div key={section.id} className="portal-section" style={{ marginBottom: 24 }}>
                <div className="portal-section-title">{section.title}</div>
                {isTableSection(section.id) ? (
                  <SowPortalTable sectionId={section.id} rows={section.table || []} currency={sow.currency} language={sow.language} />
                ) : (
                  <div
                    className="portal-section-body"
                    dangerouslySetInnerHTML={{ __html: section.content }}
                    style={{ fontSize: 14, color: '#333', lineHeight: 1.75 }}
                  />
                )}
              </div>
            ))}
          </div>
          {signatureProse && (
            <div className="portal-doc-body" style={{ paddingTop: 0 }}>
              <div className="portal-section-body" style={{ fontSize: 14, color: '#333', lineHeight: 1.75 }}
                dangerouslySetInnerHTML={{ __html: signatureProse }} />
            </div>
          )}
        </div>

        {/* Action card */}
        {mode === 'view' && (
          <div className="portal-action-card" style={{ borderTopColor: accent }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontWeight: 400, margin: '0 0 6px' }}>
              Ready to proceed?
            </h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 18px', lineHeight: 1.6 }}>
              Review the full Statement of Work above, then sign to confirm your agreement,
              or let us know if you&apos;d like any changes.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                className="btn"
                style={{ background: accent, color: '#FFF', padding: '10px 22px', fontSize: 13, fontWeight: 600 }}
                onClick={() => setMode('sign')}
              >
                <i className="ti ti-pencil" style={{ fontSize: 13 }} /> Sign agreement
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setMode('changes')}
              >
                Request changes
              </button>
              <button
                className="btn btn-ghost"
                style={{ color: '#B91C1C', borderColor: '#FECACA' }}
                onClick={() => setMode('decline')}
              >
                Decline
              </button>
            </div>
            <p style={{ fontSize: 11, color: '#B0B0B0', marginTop: 14 }}>
              This link expires {new Date(sow.expiresAt).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}.
            </p>
          </div>
        )}

        {/* Sign mode */}
        {mode === 'sign' && (
          <div className="portal-action-card" style={{ borderTopColor: accent }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontWeight: 400, margin: '0 0 6px' }}>Sign this agreement</h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 18px' }}>
              Type your name, draw your signature, and click Sign to confirm you have authority to enter this agreement.
            </p>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 5, padding: '9px 12px', fontSize: 12, color: '#B91C1C', marginBottom: 14 }}>{error}</div>}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '.02em', color: '#555', marginBottom: 5 }}>
                Your full name
              </label>
              <input
                className="finp"
                value={signerName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSignerName(e.target.value)}
                placeholder="Type your full name to sign"
                autoFocus
                style={{ fontFamily: 'Georgia,serif', fontSize: 16 }}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <label style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.02em', color: '#555' }}>
                  Draw your signature
                </label>
                <button type="button" onClick={() => { sigPadRef.current?.clear(); setSigEmpty(true) }}
                  style={{ background: 'none', border: 'none', fontSize: 11, color: '#909090', cursor: 'pointer', textDecoration: 'underline' }}>
                  Clear
                </button>
              </div>
              <SignaturePad ref={sigPadRef} strokeColour={accent} />
            </div>
            {sow.agencySignatureData && (
              <div style={{ marginBottom: 18, padding: '10px 14px', background: '#FAFAF6', border: '1px solid #F0F0EA', borderRadius: 5 }}>
                <div style={{ fontSize: 10.5, color: '#909090', marginBottom: 4 }}>Already signed by {sow.agencyName}</div>
                <img src={sow.agencySignatureData} alt={`${sow.agencyName} signature`} style={{ height: 34 }} />
              </div>
            )}
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 18 }}>
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAgreed(e.target.checked)}
                style={{ width: 16, height: 16, marginTop: 1, accentColor: accent, flexShrink: 0 }}
              />
              <span style={{ fontSize: 13, color: '#333', lineHeight: 1.6 }}>
                I have read and agree to all the terms in this Statement of Work, including the scope,
                payment terms, and revision policy.
              </span>
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="btn"
                style={{ background: accent, color: '#FFF', padding: '10px 22px', fontSize: 13, fontWeight: 600 }}
                onClick={handleSign}
                disabled={submitting || !signerName.trim() || !agreed}
              >
                {submitting ? <><span className="spin" style={{ width: 14, height: 14 }} /> Signing…</> : `Sign as ${signerName || '…'}`}
              </button>
              <button className="btn btn-ghost" onClick={() => { setMode('view'); setError('') }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Request changes mode */}
        {mode === 'changes' && (
          <div className="portal-action-card" style={{ borderTopColor: '#B45309' }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontWeight: 400, margin: '0 0 6px' }}>Request changes</h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
              Describe what you&apos;d like changed and the agency will send an updated agreement.
            </p>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 5, padding: '9px 12px', fontSize: 12, color: '#B91C1C', marginBottom: 12 }}>{error}</div>}
            <textarea
              className="finp"
              style={{ minHeight: 100, resize: 'vertical', marginBottom: 14 }}
              value={changesNote}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setChangesNote(e.target.value)}
              placeholder="Describe the changes you'd like to see…"
              autoFocus
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="btn"
                style={{ background: '#B45309', color: '#FFF', padding: '10px 22px', fontSize: 13 }}
                onClick={handleRequestChanges}
                disabled={submitting || changesNote.trim().length < 20}
              >
                {submitting ? <span className="spin" style={{ width: 14, height: 14 }} /> : 'Send feedback'}
              </button>
              <button className="btn btn-ghost" onClick={() => { setMode('view'); setError('') }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Decline mode */}
        {mode === 'decline' && (
          <div className="portal-action-card" style={{ borderTopColor: '#B91C1C' }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontWeight: 400, margin: '0 0 6px' }}>Decline this agreement</h3>
            <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
              You can optionally share why you&apos;re declining. The agency will be notified.
            </p>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 5, padding: '9px 12px', fontSize: 12, color: '#B91C1C', marginBottom: 12 }}>{error}</div>}
            <textarea
              className="finp"
              style={{ minHeight: 80, resize: 'vertical', marginBottom: 14 }}
              value={declineReason}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDeclineReason(e.target.value)}
              placeholder="Optional: reason for declining"
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="btn btn-danger"
                style={{ padding: '10px 22px', fontSize: 13 }}
                onClick={handleDecline}
                disabled={submitting}
              >
                {submitting ? <span className="spin" style={{ width: 14, height: 14, borderColor: 'rgba(185,28,28,.2)', borderTopColor: '#B91C1C' }} /> : 'Decline agreement'}
              </button>
              <button className="btn btn-ghost" onClick={() => { setMode('view'); setError('') }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </PortalShell>
  )
}

function Loading() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 80 }}>
      <span className="spin spin-dark" style={{ width: 24, height: 24 }} />
    </div>
  )
}

function PortalShell({ children, accent, agencyName, logoUrl }: {
  children: React.ReactNode; accent?: string; agencyName?: string; logoUrl?: string | null
}) {
  return (
    <div className="portal-root">
      <div className="portal-header">
        <div className="portal-header-brand">
          {logoUrl ? (
            <img src={logoUrl} alt={agencyName} style={{ height: 28, objectFit: 'contain' }} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 26, height: 26, background: accent || '#1A5C3A', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="ti ti-scale" style={{ fontSize: 14, color: '#FFF' }} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#1A1A1A' }}>{agencyName || 'ScopeGov'}</span>
            </div>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#909090', display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-lock" style={{ fontSize: 11 }} />
          Secured by ScopeGov
        </div>
      </div>
      {children}
    </div>
  )
}

/** Deliverables/Timeline/Roles table for the client-facing portal page — mirrors SowTable in lib/pdf/sow-table.tsx so the signer sees the same structure they'll get on the downloaded PDF. */
// FIX (section-9 audit, build-blocking): the prop type was a hand-written
// union of three ids that was never updated when 'payment_schedule' was
// added to SowTableSectionId. `isTableSection()` (the caller's guard)
// narrows to the full SowTableSectionId, so this failed `tsc --noEmit`
// outright — the type union and the schema it indexes into had drifted
// apart. Use the schema's own type so they can't drift again.
function SowPortalTable({ sectionId, rows, language }: { sectionId: SowTableSectionId; rows: SowTableRow[]; currency?: string; language?: string }) {
  const schema = SOW_TABLE_SCHEMAS[sectionId]
  // FIX (section-9/10 fix round): this used to return null on an empty
  // table, leaving the section's heading (rendered by the caller) sitting
  // over completely blank space — the exact bug lib/pdf/sow-table.tsx
  // already fixed for the PDF ("a numbered section heading printed over
  // completely blank space"). This is the client's actual signing page —
  // more consequential than the PDF, not less — and could still hit this
  // whenever an agency deletes every row of a table section in the editor
  // before sending. Match the PDF's placeholder instead of hiding it.
  if (!rows || rows.length === 0) {
    return (
      <div style={{
        border: '1px dashed #D8D4C8', borderRadius: 4, padding: '10px 12px', marginTop: 8,
      }}>
        <span style={{ fontSize: 13, color: '#B0B0B0', fontStyle: 'italic' }}>To be defined</span>
      </div>
    )
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8, border: '1px solid #E5E1D8', borderRadius: 4 }}>
      <thead>
        <tr>
          {schema.columns.map(col => (
            <th key={col.key} style={{
              textAlign: col.align || 'left', padding: '8px 10px', fontSize: 11, fontWeight: 700,
              color: '#909090', textTransform: 'uppercase', letterSpacing: '.04em',
              background: '#F9F8F5', borderBottom: '1px solid #E5E1D8',
            }}>
              {columnLabel(col, language)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {schema.columns.map(col => (
              <td key={col.key} style={{
                textAlign: col.align || 'left', padding: '8px 10px', color: '#333',
                borderBottom: i === rows.length - 1 ? 'none' : '1px solid #F2F0EA',
              }}>
                {row[col.key] || '—'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
