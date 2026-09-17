'use client'
import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PROJECT_TYPE_ICONS } from '@/lib/utils/format'
import type { ProjectType, Client } from '@/lib/supabase/types'

const STEPS = ['Basics', 'Brief', 'Review & Send']
const PROJECT_TYPES: Array<{ key: ProjectType; label: string; sub: string }> = [
  { key: 'web',       label: 'Web Design',   sub: 'Websites & landing pages' },
  { key: 'mobile',    label: 'Mobile App',   sub: 'iOS & Android' },
  { key: 'brand',     label: 'Branding',     sub: 'Identity & strategy' },
  { key: 'ecomm',     label: 'E-Commerce',   sub: 'Shops & marketplaces' },
  { key: 'marketing', label: 'Marketing',    sub: 'Campaigns & content' },
  { key: 'retainer',  label: 'Retainer',     sub: 'Ongoing relationship' },
  { key: 'video',     label: 'Video',        sub: 'Animation & production' },
  { key: 'other',     label: 'Other',        sub: 'Custom project' },
]

export default function NewProjectPage() {
  // FIX (re-audit, Clients section): this page never read the clientId
  // query param at all — the two "New project" links on a client's detail
  // page (/projects/new?clientId=...) silently did nothing with it, forcing
  // the person to re-search and re-select the same client by hand, with a
  // real risk of creating an accidental duplicate client record if the
  // name/email they type doesn't match exactly. Wrapped in Suspense per
  // Next's requirement for useSearchParams (see app/mfa-challenge/page.tsx
  // for the same pattern already used in this codebase).
  return (
    <Suspense fallback={null}>
      <NewProjectPageInner />
    </Suspense>
  )
}

function NewProjectPageInner() {
  const router   = useRouter()
  const searchParams = useSearchParams()
  const [step,    setStep]    = useState(0)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)

  // Step 0: Basics
  const [clientId,     setClientId]     = useState('')
  const [clientName,   setClientName]   = useState('')
  const [clientEmail,  setClientEmail]  = useState('')
  const [isNewClient,  setIsNewClient]  = useState(false)
  const [clients,      setClients]      = useState<Client[]>([])
  const [clientSearch, setClientSearch] = useState('')
  const [projectName,  setProjectName]  = useState('')
  const [projectDisc,  setProjectDisc]  = useState('')
  const [projectType,  setProjectType]  = useState<ProjectType>('web')
  const [contractValue, setContractValue] = useState('')
  const [currency,     setCurrency]     = useState('USD')
  const [startDate,    setStartDate]    = useState('')
  const [internalRef,  setInternalRef]  = useState('')
  // FIX (deep audit, section 7 — flagship finding): retainer_duration_months
  // is read by api/cron/retainer-milestones to decide when to stop
  // generating monthly retainer invoices, but had no field anywhere in
  // the product to set it — it was permanently null, so the cron's
  // `.not('retainer_duration_months', 'is', null)` filter matched zero
  // projects, ever. Only meaningful for the 'retainer' project type.
  const [retainerMonths, setRetainerMonths] = useState('12')

  // Step 1: Brief
  const [briefMode,    setBriefMode]    = useState<'ai' | 'manual'>('ai')
  const [briefText,    setBriefText]    = useState('')
  const [briefParsing, setBriefParsing] = useState(false)
  const [objective,    setObjective]    = useState('')
  const [deliverables, setDeliverables] = useState('')
  const [outOfScope,   setOutOfScope]   = useState('')
  const [timeline,     setTimeline]     = useState('')
  const [paymentStructure, setPaymentStructure] = useState('50_50')
  const [revisionRounds,   setRevisionRounds]   = useState('2')

  const guardianItems = [
    'SOW generated from this brief',
    'Guardian activates when client signs',
    'Scope flags auto-detected from client emails',
    'Change orders drafted from flags',
    'Amendments tracked against original scope',
  ]

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then(json => {
      const list = json.clients || []
      setClients(list)
      // FIX (re-audit, Clients section): resolve the ?clientId= deep link
      // now that the client list is loaded — it was previously ignored
      // entirely (no useSearchParams usage in this file at all).
      const preselectId = searchParams.get('clientId')
      if (preselectId) {
        const match = list.find((c: Client) => c.id === preselectId)
        if (match) {
          setClientId(match.id); setClientName(match.name); setClientSearch(match.name)
        }
      }
    }).catch(() => {})
  }, [])

  // FIX (deep audit, section 5 re-pass): completes per-project-type SOW
  // defaults (see app/api/workspace/defaults/route.ts) — this always
  // fetched only the workspace-wide global row, so picking a different
  // project type here never changed the pre-filled payment structure /
  // revision rounds even when the agency had configured a specific
  // override for that type in Settings → Defaults. Refetches whenever
  // projectType changes; `defaultsTouched` stops it from clobbering a
  // value the person already deliberately edited on Step 2 after
  // changing their mind about the project type back on Step 1.
  const [defaultsTouched, setDefaultsTouched] = useState(false)
  // FIX: currency was previously only ever set once on mount, so a
  // manual change to it here could never be clobbered. Making this
  // effect re-run on projectType changes introduced exactly that risk
  // for currency too (it's workspace-wide, not per-type, so every
  // refetch would return the same value and stomp a deliberate manual
  // pick) — tracked separately since it can be touched independently of
  // payment structure / revision rounds.
  const [currencyTouched, setCurrencyTouched] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/workspace/defaults?projectType=${projectType}`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return
        if (json.currency && !currencyTouched) setCurrency(json.currency)
        if (!defaultsTouched) {
          if (json.paymentStructure) setPaymentStructure(json.paymentStructure)
          if (json.revisionRounds)   setRevisionRounds(String(json.revisionRounds))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
    // currencyTouched/defaultsTouched are intentionally excluded — they
    // gate what the response is allowed to overwrite, not what should
    // trigger a new fetch. Including them would refetch on every edit to
    // an unrelated field for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectType])

  const filteredClients = clients.filter(c =>
    c.name.toLowerCase().includes(clientSearch.toLowerCase()) ||
    c.email.toLowerCase().includes(clientSearch.toLowerCase())
  )

  async function handleBasicsSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!projectName || !projectType) return
    if (!clientId && (!clientName || !clientEmail)) {
      setError('Select an existing client or enter a new client name and email.')
      return
    }
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: clientId || null,
          newClient: !clientId ? { name: clientName, email: clientEmail } : null,
          name: projectName, disc: projectDisc || null, type: projectType,
          contractValue: parseFloat(contractValue) || 0, currency,
          startDate: startDate || null, internalRef: internalRef || null,
          retainerDurationMonths: projectType === 'retainer' ? (retainerMonths || null) : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create project')
      setProjectId(json.projectId)
      setStep(1)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setLoading(false) }
  }

  async function handleBriefParse() {
    if (!briefText.trim() || !projectId) return
    setBriefParsing(true); setError('')
    try {
      const res  = await fetch('/api/sow/parse-brief', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ briefText, projectId, projectType }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      const brief = json.brief || {}
      setObjective(brief.objective || '')
      setDeliverables(brief.deliverables || '')
      setOutOfScope(brief.outOfScope || '')
      setTimeline(brief.timeline || '')
      setPaymentStructure(brief.paymentStructure || '50_50')
      setRevisionRounds(String(brief.revisionRounds || 2))
      // Mark touched: these came from the AI-parsed brief, a more
      // specific source than the workspace/type default this component
      // pre-fills from. If the person goes back and changes project type
      // afterward, that shouldn't silently discard what was just parsed.
      setDefaultsTouched(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not parse brief — please fill in manually')
      setBriefMode('manual')
    } finally { setBriefParsing(false) }
  }

  async function handleBriefSubmit() {
    if (!projectId) return
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/sow/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId, projectType, objective, deliverables, outOfScope, timeline,
          paymentStructure, revisionRounds: parseInt(revisionRounds),
          contractValue: parseFloat(contractValue) || 0, currency,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to generate SOW')
      router.push(`/projects/${projectId}?tab=sow&new=1`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to generate SOW')
    } finally { setLoading(false) }
  }

  return (
    <div className="wizard">
      <div className="wizard-form">
        {/* Step indicator */}
        <div className="wizard-steps">
          {STEPS.map((s, i) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center' }}>
              <div className="ws-step">
                <div className={`ws-num ${i < step ? 'done' : i === step ? 'active' : 'pending'}`}>
                  {i < step ? <i className="ti ti-check" style={{ fontSize: 11 }} /> : i + 1}
                </div>
                <span className={`ws-label ${i < step ? 'done' : i === step ? 'active' : 'pending'}`}>{s}</span>
              </div>
              {i < STEPS.length - 1 && <div className="ws-connector" />}
            </div>
          ))}
        </div>

        {/* STEP 0: Basics */}
        {step === 0 && (
          <form onSubmit={handleBasicsSubmit}>
            <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 24, fontWeight: 400, marginBottom: 20 }}>Project basics</h2>
            {error && <div className="auth-error">{error}</div>}

            <div className="fgrp">
              <label className="flbl">Client</label>
              {!isNewClient ? (
                <>
                  <input className="finp" placeholder="Search existing clients…" value={clientSearch} autoFocus
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientSearch(e.target.value)} />
                  {clientSearch && (
                    <div className="surface" style={{ marginTop: 4, maxHeight: 200, overflowY: 'auto', position: 'relative', zIndex: 10 }}>
                      {filteredClients.length === 0 ? (
                        <div style={{ padding: '10px 12px' }}>
                          <span style={{ fontSize: 13, color: 'var(--text-3)' }}>No match — </span>
                          <button type="button" className="auth-link" style={{ fontSize: 13, background: 'none', border: 'none', padding: 0 }}
                            onClick={() => { setIsNewClient(true); setClientName(clientSearch); setClientSearch('') }}>
                            create new client
                          </button>
                        </div>
                      ) : (
                        filteredClients.map(c => (
                          <button key={c.id} type="button"
                            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', borderBottom: '1px solid var(--surface-2)' }}
                            onClick={() => { setClientId(c.id); setClientName(c.name); setClientSearch(c.name) }}>
                            <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                              {c.name}
                              {/* FIX (re-audit, Clients section): this list showed archived
                                  clients with zero indication — selecting one silently
                                  attached them to a brand-new active project with no
                                  warning. (The server now reactivates them on creation;
                                  this at least tells the person that's what's about to
                                  happen instead of it being invisible.) */}
                              {c.status === 'archived' && <span className="pill pill-slate pill-sm">Archived</span>}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{c.email}</div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  {clientId && (
                    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="pill pill-green"><i className="ti ti-check" style={{ fontSize: 10 }} /> {clientName}</span>
                      <button type="button" className="auth-link" style={{ fontSize: 11, background: 'none', border: 'none', padding: 0 }}
                        onClick={() => { setClientId(''); setClientName(''); setClientSearch('') }}>Change</button>
                    </div>
                  )}
                  {!clientId && (
                    <button type="button" className="auth-link" style={{ fontSize: 12, marginTop: 6, background: 'none', border: 'none', padding: 0, display: 'block' }}
                      onClick={() => setIsNewClient(true)}>+ New client</button>
                  )}
                </>
              ) : (
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12 }}>
                  <div className="f2">
                    <div>
                      <label className="flbl">Client name</label>
                      <input className="finp" value={clientName} required autoFocus
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientName(e.target.value)} placeholder="Acme Corp" />
                    </div>
                    <div>
                      <label className="flbl">Client email</label>
                      <input type="email" className="finp" value={clientEmail} required
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientEmail(e.target.value)} placeholder="contact@acme.com" />
                    </div>
                  </div>
                  <button type="button" className="auth-link" style={{ fontSize: 12, marginTop: 8, background: 'none', border: 'none', padding: 0 }}
                    onClick={() => { setIsNewClient(false); setClientName(''); setClientEmail('') }}>← Search existing clients</button>
                </div>
              )}
            </div>

            <div className="fgrp">
              <label className="flbl">Project name</label>
              <input className="finp" value={projectName} required placeholder="Website Redesign"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProjectName(e.target.value)} />
            </div>

            <div className="fgrp">
              <label className="flbl">Subtitle <span className="fhint">— optional, disambiguates similar projects</span></label>
              <input className="finp" value={projectDisc} placeholder="Phase 2"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProjectDisc(e.target.value)} />
            </div>

            <div className="fgrp">
              <label className="flbl">Project type</label>
              <div className="type-grid">
                {PROJECT_TYPES.map(pt => (
                  <button key={pt.key} type="button" className={`type-card${projectType === pt.key ? ' selected' : ''}`}
                    onClick={() => setProjectType(pt.key)}>
                    <i className={`ti ${PROJECT_TYPE_ICONS[pt.key]} type-icon`} />
                    <div className="type-name">{pt.label}</div>
                    <div className="type-sub">{pt.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="f2">
              <div className="fgrp">
                <label className="flbl">Contract value</label>
                <input type="number" className="finp" value={contractValue} min={0} step="0.01" placeholder="5000"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setContractValue(e.target.value)} />
              </div>
              <div className="fgrp">
                <label className="flbl">Currency</label>
                <select className="finp" value={currency} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setCurrencyTouched(true); setCurrency(e.target.value) }}>
                  {['USD','KES','GBP','EUR','ZAR','NGN','GHS','AED'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div className="f2" style={{ marginBottom: 24 }}>
              <div className="fgrp">
                <label className="flbl">Start date <span className="fhint">— optional</span></label>
                <input type="date" className="finp" value={startDate}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStartDate(e.target.value)} />
              </div>
              {projectType === 'retainer' ? (
                <div className="fgrp">
                  <label className="flbl">Retainer duration <span className="fhint">— months</span></label>
                  <input type="number" className="finp" value={retainerMonths} min={1} max={60} step="1" placeholder="12"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRetainerMonths(e.target.value)} />
                </div>
              ) : (
                <div className="fgrp">
                  <label className="flbl">Internal ref <span className="fhint">— optional</span></label>
                  <input className="finp" value={internalRef} placeholder="INV-2024-001"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInternalRef(e.target.value)} />
                </div>
              )}
            </div>
            {projectType === 'retainer' && (
              <div className="fgrp" style={{ marginBottom: 24 }}>
                <label className="flbl">Internal ref <span className="fhint">— optional</span></label>
                <input className="finp" value={internalRef} placeholder="INV-2024-001"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInternalRef(e.target.value)} />
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={loading || !projectName || (!clientId && (!clientName || !clientEmail))}>
                {loading ? <span className="spin" /> : <>Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
            </div>
          </form>
        )}

        {/* STEP 1: Brief */}
        {step === 1 && (
          <div>
            <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 24, fontWeight: 400, marginBottom: 6 }}>Scope brief</h2>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 20 }}>
              This becomes your SOW. Be specific — Guardian uses it to detect scope creep.
            </p>
            {error && <div className="auth-error">{error}</div>}

            <div style={{ display: 'inline-flex', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', padding: 3, marginBottom: 20 }}>
              <button type="button" onClick={() => setBriefMode('ai')}
                style={{ padding: '6px 14px', borderRadius: 4, fontSize: 12, border: 'none', cursor: 'pointer',
                  background: briefMode === 'ai' ? 'var(--surface)' : 'transparent',
                  color: briefMode === 'ai' ? 'var(--text)' : 'var(--text-3)', fontWeight: briefMode === 'ai' ? 500 : 400 }}>
                <i className="ti ti-wand" style={{ fontSize: 12, marginRight: 5 }} />AI pre-fill
              </button>
              <button type="button" onClick={() => setBriefMode('manual')}
                style={{ padding: '6px 14px', borderRadius: 4, fontSize: 12, border: 'none', cursor: 'pointer',
                  background: briefMode === 'manual' ? 'var(--surface)' : 'transparent',
                  color: briefMode === 'manual' ? 'var(--text)' : 'var(--text-3)', fontWeight: briefMode === 'manual' ? 500 : 400 }}>
                <i className="ti ti-pencil" style={{ fontSize: 12, marginRight: 5 }} />Manual
              </button>
            </div>

            {briefMode === 'ai' && (
              <div className="fgrp">
                <label className="flbl">Paste brief, email, or notes</label>
                <textarea className="finp" style={{ minHeight: 120, resize: 'vertical' }}
                  placeholder="Paste any text — a client email, Slack message, notes from a call. AI will extract the scope."
                  value={briefText} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setBriefText(e.target.value)} />
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
                  onClick={handleBriefParse} disabled={briefParsing || !briefText.trim()}>
                  {briefParsing ? <><span className="spin spin-dark" /> Extracting…</> : <><i className="ti ti-wand" style={{ fontSize: 12 }} /> Extract scope</>}
                </button>
              </div>
            )}

            {(briefMode === 'manual' || objective) && (
              <>
                <div className="fgrp">
                  <label className="flbl">Objective</label>
                  <textarea className="finp" style={{ minHeight: 72, resize: 'vertical' }} value={objective}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setObjective(e.target.value)}
                    placeholder="What is this project trying to achieve?" />
                </div>
                <div className="fgrp">
                  <label className="flbl">Deliverables <span className="fhint">— one per line</span></label>
                  <textarea className="finp" style={{ minHeight: 100, resize: 'vertical' }} value={deliverables}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDeliverables(e.target.value)}
                    placeholder="Homepage design&#10;Contact page&#10;Mobile-responsive layouts" />
                </div>
                <div className="fgrp">
                  <label className="flbl">Out of scope <span className="fhint">— explicitly excluded, one per line</span></label>
                  <textarea className="finp" style={{ minHeight: 80, resize: 'vertical' }} value={outOfScope}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setOutOfScope(e.target.value)}
                    placeholder="Content writing&#10;SEO optimization&#10;Hosting setup" />
                </div>
                <div className="fgrp">
                  <label className="flbl">Timeline</label>
                  <input className="finp" value={timeline} placeholder="6 weeks from kick-off"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTimeline(e.target.value)} />
                </div>
                <div className="f2">
                  <div className="fgrp">
                    <label className="flbl">Payment structure</label>
                    <select className="finp" value={paymentStructure} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setDefaultsTouched(true); setPaymentStructure(e.target.value) }}>
                      <option value="50_50">50% upfront, 50% on delivery</option>
                      <option value="100_upfront">100% upfront</option>
                      <option value="milestones">Milestone-based</option>
                      <option value="monthly">Monthly retainer</option>
                      <option value="on_delivery">100% on delivery</option>
                    </select>
                  </div>
                  <div className="fgrp">
                    <label className="flbl">Revision rounds</label>
                    <select className="finp" value={revisionRounds} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setDefaultsTouched(true); setRevisionRounds(e.target.value) }}>
                      {['1','2','3','4','5'].map(n => <option key={n} value={n}>{n} round{n !== '1' ? 's' : ''}</option>)}
                    </select>
                  </div>
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-ghost" onClick={() => setStep(0)}>← Back</button>
              <button className="btn btn-primary" onClick={handleBriefSubmit} disabled={loading || (!objective && !deliverables)}>
                {loading ? <><span className="spin" /> Generating SOW…</> : <><i className="ti ti-wand" style={{ fontSize: 12 }} /> Generate SOW</>}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Guardian pane */}
      <div className="guardian-pane">
        <div className="guardian-pane-title">
          <i className="ti ti-shield-bolt" style={{ fontSize: 13 }} />
          Guardian protection
        </div>
        {guardianItems.map((item, i) => (
          <div key={i} className="guardian-item">
            <i className="ti ti-check guardian-item-ic" />
            {item}
          </div>
        ))}
        <p className="guardian-note">
          Guardian monitors every client communication for out-of-scope requests
          and auto-drafts change orders — so you never miss billable work.
        </p>
      </div>
    </div>
  )
}
