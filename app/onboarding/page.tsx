'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

const STEPS = [
  { label: 'Your agency',   sub: 'Identity & locale' },
  { label: 'Branding',      sub: 'Logo & colour' },
  { label: 'Defaults',      sub: 'SOW preferences' },
  { label: 'Team',          sub: 'First invitation' },
  { label: 'Done',          sub: 'Start governing' },
]

const INDUSTRIES = [
  'Creative & Design', 'Web & App Development', 'Marketing & Advertising',
  'Branding & Identity', 'Video & Animation', 'Architecture & Interior',
  'Consulting & Strategy', 'Photography', 'PR & Communications', 'Other',
]
const CURRENCIES = ['USD','KES','GBP','EUR','ZAR','NGN','GHS','AED','CAD','AUD']
const TIMEZONES  = [
  'Africa/Nairobi','Africa/Lagos','Africa/Accra','Africa/Johannesburg','Africa/Cairo',
  'Europe/London','Europe/Paris','America/New_York','America/Los_Angeles',
  'Asia/Dubai','Asia/Kolkata','Australia/Sydney',
]

export default function OnboardingPage() {
  const router   = useRouter()
  const supabase = createClient()

  const [step,        setStep]        = useState(0)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)

  // Step 0
  const [agencyName, setAgencyName] = useState('')
  const [industry,   setIndustry]   = useState('')
  const [currency,   setCurrency]   = useState('USD')
  const [timezone,   setTimezone]   = useState('America/New_York')

  // Step 1
  const [brandColour,  setBrandColour]  = useState('#1A5C3A')
  const [logoFile,     setLogoFile]     = useState<File | null>(null)
  const [logoPreview,  setLogoPreview]  = useState<string | null>(null)
  const [uploading,    setUploading]    = useState(false)

  // Step 2
  const [revisionRounds,   setRevisionRounds]   = useState('2')
  const [paymentStructure, setPaymentStructure] = useState('50_50')
  const [governingLaw,     setGoverningLaw]     = useState('United States')

  // Step 3
  const [inviteEmail, setInviteEmail] = useState('')

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.push('/login'); return }
      const userName = user.user_metadata?.name || ''
      if (userName) setAgencyName(`${userName.split(' ')[0]}'s Agency`)
    })
  }, [])

  /* ── Step 0: Identity ─────────────────────────────────────── */
  async function submitIdentity(e: React.FormEvent) {
    e.preventDefault()
    if (!agencyName.trim() || !industry) return
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/workspace/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyName, industry, currency, timezone }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create workspace')
      setWorkspaceId(json.workspaceId)
      setStep(1)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setLoading(false) }
  }

  /* ── Step 1: Branding ─────────────────────────────────────── */
  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!['image/png','image/jpeg','image/svg+xml'].includes(file.type)) {
      setError('Logo must be PNG, JPEG, or SVG.'); return
    }
    setLogoFile(file)
    const reader = new FileReader()
    reader.onload = ev => setLogoPreview(ev.target?.result as string)
    reader.readAsDataURL(file)
  }

  async function submitBranding() {
    if (!workspaceId) return
    setLoading(true)
    setError('')
    try {
      let logoStoragePath: string | null = null
      if (logoFile) {
        setUploading(true)
        const ext  = logoFile.name.split('.').pop()
        const path = `${workspaceId}/logo.${ext}`
        const { error: upErr } = await (supabase as any).storage
          .from('logos').upload(path, logoFile, { upsert: true })
        setUploading(false)
        if (!upErr) logoStoragePath = path
      }
      await fetch('/api/workspace/branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, brandColour, logoStoragePath }),
      })
      setStep(2)
    } catch { setError('Branding save failed — you can update this in Settings.') }
    finally { setLoading(false); setUploading(false) }
  }

  /* ── Step 2: Defaults ─────────────────────────────────────── */
  async function submitDefaults() {
    if (workspaceId) {
      await fetch('/api/workspace/defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, revisionRounds: parseInt(revisionRounds), paymentStructure, governingLaw }),
      }).catch(() => {}) // non-fatal
    }
    setStep(3)
  }

  /* ── Step 3: Invite ───────────────────────────────────────── */
  async function submitInvite() {
    if (inviteEmail.trim() && workspaceId) {
      await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, workspaceId }),
      }).catch(() => {})
    }
    setStep(4)
  }

  /* ── Step 4: Complete ─────────────────────────────────────── */
  async function complete() {
    if (!workspaceId) return
    setLoading(true)
    try {
      await fetch('/api/workspace/complete-onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      router.push('/dashboard')
    } finally { setLoading(false) }
  }

  return (
    <div className="ob-root">
      <div className="ob-card">
        {/* Progress bar */}
        <div className="ob-progress">
          {STEPS.map((_, i) => (
            <div key={i} className={`ob-prog-seg ${i <= step ? 'done' : 'pending'}`} />
          ))}
        </div>

        {/* Step label */}
        <div className="ob-step-lbl">
          Step {step + 1} of {STEPS.length} — {STEPS[step].label}
        </div>

        {/* ── STEP 0 ──────────────────────────────────────── */}
        {step === 0 && (
          <form onSubmit={submitIdentity}>
            <h2 className="ob-title">Tell us about your agency</h2>
            <p className="ob-sub">This appears on all client-facing documents and emails.</p>
            {error && <div className="auth-error">{error}</div>}

            <div className="fgrp">
              <label className="flbl">Agency name</label>
              <input className="finp" value={agencyName} placeholder="Meridian Creative" autoFocus required
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAgencyName(e.target.value)} />
            </div>
            <div className="fgrp">
              <label className="flbl">Industry</label>
              <select className="finp" value={industry} required
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setIndustry(e.target.value)}>
                <option value="" disabled>Select your industry</option>
                {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
            <div className="f2">
              <div className="fgrp">
                <label className="flbl">Default currency</label>
                <select className="finp" value={currency}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCurrency(e.target.value)}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="fgrp">
                <label className="flbl">Timezone</label>
                <select className="finp" value={timezone}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTimezone(e.target.value)}>
                  {TIMEZONES.map(t => <option key={t} value={t}>{t.replace(/_/g,' ')}</option>)}
                </select>
              </div>
            </div>

            <div className="ob-nav">
              <span />
              <button type="submit" className="btn btn-primary" disabled={loading || !agencyName.trim() || !industry}>
                {loading ? <span className="spin" /> : <>Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
            </div>
          </form>
        )}

        {/* ── STEP 1 ──────────────────────────────────────── */}
        {step === 1 && (
          <div>
            <h2 className="ob-title">Add your branding</h2>
            <p className="ob-sub">Your logo and brand colour appear on all SOW PDFs and client emails.</p>
            {error && <div className="auth-error">{error}</div>}

            <div className="fgrp">
              <label className="flbl">Agency logo</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ width: 64, height: 64, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                  {logoPreview
                    ? <img src={logoPreview} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    : <i className="ti ti-building" style={{ fontSize: 24, color: 'var(--text-4)' }} />}
                </div>
                <div>
                  <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                    <i className="ti ti-upload" style={{ fontSize: 12 }} />
                    {uploading ? 'Uploading…' : logoFile ? 'Change logo' : 'Upload logo'}
                    <input type="file" accept="image/png,image/jpeg,image/svg+xml" style={{ display: 'none' }}
                      onChange={handleLogoChange} />
                  </label>
                  <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>PNG, JPEG, or SVG · Max 2 MB</p>
                </div>
              </div>
            </div>

            <div className="fgrp">
              <label className="flbl">Brand colour</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="color" value={brandColour}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBrandColour(e.target.value)}
                  style={{ width: 40, height: 38, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: 2, background: 'var(--surface)' }} />
                <input className="finp" value={brandColour} style={{ width: 130 }}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBrandColour(e.target.value)}
                  placeholder="#1A5C3A" />
                <div style={{ width: 38, height: 38, borderRadius: 'var(--radius-sm)', background: brandColour, border: '1px solid var(--border)', flexShrink: 0 }} />
              </div>
            </div>

            <div className="ob-nav">
              <button className="ob-skip" onClick={() => setStep(2)}>Skip for now</button>
              <button className="btn btn-primary" onClick={submitBranding} disabled={loading}>
                {loading ? <span className="spin" /> : <>Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2 ──────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <h2 className="ob-title">Set your SOW defaults</h2>
            <p className="ob-sub">These pre-fill every new Statement of Work. You can override them per project at any time.</p>

            <div className="f2">
              <div className="fgrp">
                <label className="flbl">Revision rounds (default)</label>
                <select className="finp" value={revisionRounds}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRevisionRounds(e.target.value)}>
                  {['1','2','3','4','5'].map(n => <option key={n} value={n}>{n} round{n !== '1' ? 's' : ''}</option>)}
                </select>
              </div>
              <div className="fgrp">
                <label className="flbl">Default payment structure</label>
                <select className="finp" value={paymentStructure}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPaymentStructure(e.target.value)}>
                  <option value="50_50">50% upfront / 50% on delivery</option>
                  <option value="100_upfront">100% upfront</option>
                  <option value="milestones">Milestone-based</option>
                  <option value="monthly">Monthly retainer</option>
                  <option value="on_delivery">100% on delivery</option>
                </select>
              </div>
            </div>
            <div className="fgrp">
              <label className="flbl">Governing law</label>
              <input className="finp" value={governingLaw}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGoverningLaw(e.target.value)}
                placeholder="United States" />
            </div>

            <div className="ob-nav">
              <button className="ob-skip" onClick={() => setStep(3)}>Skip</button>
              <button className="btn btn-primary" onClick={submitDefaults}>
                Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3 ──────────────────────────────────────── */}
        {step === 3 && (
          <div>
            <h2 className="ob-title">Invite a team member</h2>
            <p className="ob-sub">Add a colleague to your workspace. You can invite more people any time from the Team page.</p>

            <div className="fgrp">
              <label className="flbl">Email address <span className="fhint">— optional</span></label>
              <input type="email" className="finp" value={inviteEmail} autoFocus
                placeholder="colleague@youragency.com"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(e.target.value)} />
            </div>

            <div className="ob-nav">
              <button className="ob-skip" onClick={() => setStep(4)}>Skip for now</button>
              <button className="btn btn-primary" onClick={submitInvite} disabled={loading}>
                {loading ? <span className="spin" /> : <>Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 4 ──────────────────────────────────────── */}
        {step === 4 && (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{ width: 64, height: 64, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <i className="ti ti-scale" style={{ fontSize: 28, color: 'var(--green)' }} />
            </div>
            <h2 className="ob-title" style={{ textAlign: 'center' }}>Governance is set up</h2>
            <p className="ob-sub" style={{ textAlign: 'center', marginBottom: 28 }}>
              <strong style={{ color: 'var(--text)' }}>Welcome to ScopeGov.</strong> Create your first project,
              generate a Statement of Work, send it to your client — and Guardian
              takes over from there, monitoring every communication for scope drift.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 280, margin: '0 auto' }}>
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '11px' }}
                onClick={complete} disabled={loading}>
                {loading ? <span className="spin" /> : <>Go to dashboard <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
              </button>
              <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => { complete().then(() => router.push('/projects/new')) }}>
                Create first project
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
