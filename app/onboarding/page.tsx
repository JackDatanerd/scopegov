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
  // FIX (doc-completeness audit, finding #1): this used to default to
  // 'United States' and get saved to a column SOW generation never read,
  // so agencies would see it "saved" during onboarding while every SOW
  // silently used an unrelated fallback. Starts blank now — governing
  // law is a real legal term of the contract, not something we should
  // guess on the agency's behalf — and SOW generation hard-blocks until
  // it's actually set (see app/api/sow/generate/route.ts).
  const [governingLaw,     setGoverningLaw]     = useState('')

  // Step 3
  const [inviteEmail, setInviteEmail] = useState('')

  const STORAGE_KEY_PREFIX = 'scopegov_onboarding_'
  const [restored, setRestored] = useState(false)
  // FIX (deep audit, Workspace lifecycle + Onboarding sections — headline
  // finding): see api/workspace/onboarding-status/route.ts for the full
  // story. 'waiting' means this user is an ordinary member (not the
  // creator) of a real workspace they were invited into that hasn't
  // finished onboarding yet — render a waiting screen instead of ever
  // reaching the steps below, which would otherwise spin up a second,
  // unrelated workspace for them.
  const [gate, setGate] = useState<'loading' | 'create' | 'waiting'>('loading')
  const [waitingFor, setWaitingFor] = useState<{ agencyName: string; creatorName: string } | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/login'); return }

      // FIX: restore in-progress onboarding after a refresh instead of
      // silently restarting. Scoped per-user so it can't leak across
      // accounts on a shared browser. Deliberately skips restoring if step
      // 0 was never completed (no workspaceId saved) — nothing meaningful
      // to restore in that case, and it avoids ever re-submitting step 0.
      try {
        const saved = localStorage.getItem(STORAGE_KEY_PREFIX + user.id)
        if (saved) {
          const s = JSON.parse(saved)
          if (s.workspaceId) {
            setWorkspaceId(s.workspaceId)
            setStep(s.step || 1)
            if (s.agencyName)       setAgencyName(s.agencyName)
            if (s.industry)         setIndustry(s.industry)
            if (s.currency)         setCurrency(s.currency)
            if (s.timezone)         setTimezone(s.timezone)
            if (s.brandColour)      setBrandColour(s.brandColour)
            if (s.revisionRounds)   setRevisionRounds(s.revisionRounds)
            if (s.paymentStructure) setPaymentStructure(s.paymentStructure)
            if (s.governingLaw)     setGoverningLaw(s.governingLaw)
            setRestored(true)
            setGate('create')
            return
          }
        }
      } catch { /* corrupt/unavailable storage — just start fresh */ }

      // No local progress found — ask the server whether this user should
      // actually be starting a NEW workspace at all, before assuming so.
      try {
        const res  = await fetch('/api/workspace/onboarding-status')
        const json = await res.json().catch(() => ({}))
        if (res.ok) {
          if (json.status === 'complete') { router.push('/dashboard'); return }
          if (json.status === 'waiting') {
            setWaitingFor({ agencyName: json.agencyName, creatorName: json.creatorName })
            setGate('waiting')
            setRestored(true)
            return
          }
          if (json.status === 'resume' && json.workspaceId) {
            // Creator of an incomplete workspace, but with no local
            // progress (new device, cleared storage) — resume it server-
            // side instead of creating a duplicate.
            setWorkspaceId(json.workspaceId)
            if (json.agencyName) setAgencyName(json.agencyName)
            if (json.industry)   setIndustry(json.industry)
            if (json.currency)   setCurrency(json.currency)
            if (json.timezone)   setTimezone(json.timezone)
            setStep(1)
            setRestored(true)
            setGate('create')
            return
          }
        }
      } catch { /* status check failed — fall through to normal new-workspace flow */ }

      const userName = user.user_metadata?.name || ''
      if (userName) setAgencyName(`${userName.split(' ')[0]}'s Agency`)
      setRestored(true)
      setGate('create')
    })
  }, [])

  // Persist on every relevant change, once initial restore has happened
  // (avoids overwriting saved progress with blank initial state before
  // restore runs).
  useEffect(() => {
    if (!restored || !workspaceId) return
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      localStorage.setItem(STORAGE_KEY_PREFIX + user.id, JSON.stringify({
        step, workspaceId, agencyName, industry, currency, timezone,
        brandColour, revisionRounds, paymentStructure, governingLaw,
      }))
    })
  }, [restored, step, workspaceId, agencyName, industry, currency, timezone, brandColour, revisionRounds, paymentStructure, governingLaw])

  function clearSavedProgress() {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) localStorage.removeItem(STORAGE_KEY_PREFIX + user.id)
    })
  }

  /* ── Step 0: Identity ─────────────────────────────────────── */
  async function submitIdentity(e: React.FormEvent) {
    e.preventDefault()
    if (!agencyName.trim() || !industry) return
    // FIX: if the user went Back to step 0 after already creating the
    // workspace (or somehow double-submitted), don't create a second one.
    // Persist any edits via the settings route instead, then advance.
    if (workspaceId) {
      setLoading(true); setError('')
      try {
        // FIX (section-by-section re-audit): this used to be a
        // fire-and-forget .catch(() => {}) that swallowed any server-side
        // rejection and silently advanced regardless — same shape the
        // invite step (below) was already fixed for. A failed save here
        // now blocks advancing and shows why, instead of the user
        // believing their agency identity edits were saved when they
        // weren't.
        const res  = await fetch('/api/workspace/settings', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agencyName, industry, currency, timezone }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(json.error || 'Could not save those changes — try again.')
          return
        }
        setStep(1)
      } catch {
        setError('Could not save those changes — try again.')
      } finally { setLoading(false) }
      return
    }
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
  // FIX (section-by-section re-audit — headline finding): this used to
  // upload directly from the browser via the anon-key client to
  // `${workspaceId}/logo.${ext}`. The `logos` bucket's storage policy is
  // scoped `<auth.uid()>/<filename>` (see api/workspace/branding/route.ts),
  // keyed on the USER, not the workspace — a brand-new workspace's UUID
  // is never equal to the current user's id, so that upload was rejected
  // by storage RLS on every single run, for every user, silently (the
  // failure was swallowed and the FileReader preview kept showing the
  // picked image regardless, so nobody could tell). It was ALSO,
  // independently, the exact insecure pattern
  // api/workspace/branding/logo/route.ts exists specifically to replace:
  // a client-side-only write with no magic-byte check, and — the serious
  // part — this file's own accepted-types list still allowed
  // image/svg+xml, the same live stored-XSS vector (a `<script>` inside
  // an SVG served from the public bucket's own origin) the team already
  // found and fixed by dropping SVG support entirely for the equivalent
  // Settings-page flow. It was inert today only by accident of the path
  // mismatch above. Fixed by routing through the same hardened
  // server-side endpoint Settings already uses (FormData POST, PNG/JPG
  // only, magic-byte verified, service-role write) instead of
  // reimplementing upload logic here.
  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!['image/png','image/jpeg'].includes(file.type)) {
      setError('Logo must be PNG or JPG.'); return
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
      let logoStoragePath: string | undefined
      if (logoFile) {
        setUploading(true)
        const body = new FormData()
        body.append('file', logoFile)
        const upRes  = await fetch('/api/workspace/branding/logo', { method: 'POST', body })
        const upJson = await upRes.json().catch(() => ({}))
        setUploading(false)
        if (!upRes.ok) {
          setError(upJson.error || 'Could not upload logo — you can add it later in Settings.')
          return
        }
        logoStoragePath = upJson.logoStoragePath
      }
      const res  = await fetch('/api/workspace/branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, brandColour, ...(logoStoragePath ? { logoStoragePath } : {}) }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || 'Branding save failed — you can update this in Settings.')
        return
      }
      setStep(2)
    } catch { setError('Branding save failed — you can update this in Settings.') }
    finally { setLoading(false); setUploading(false) }
  }

  /* ── Step 2: Defaults ─────────────────────────────────────── */
  async function submitDefaults() {
    if (workspaceId) {
      setLoading(true); setError('')
      // FIX (section-by-section re-audit): this used to be a
      // fire-and-forget .catch(() => {}) marked "non-fatal" that silently
      // advanced regardless of the response. governingLaw is the exact
      // field api/sow/generate/route.ts hard-blocks SOW generation
      // without — a silently-failed save here meant the user believed
      // governing law was set (they typed it, clicked Continue, saw no
      // error) and only discovered otherwise when SOW generation blocked
      // them, with nothing connecting that back to this step.
      try {
        const res  = await fetch('/api/workspace/defaults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, revisionRounds: parseInt(revisionRounds), paymentStructure, governingLaw }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(json.error || 'Could not save your defaults — try again, or skip this step.')
          return
        }
      } catch {
        setError('Could not save your defaults — try again, or skip this step.')
        return
      } finally { setLoading(false) }
    }
    setStep(3)
  }

  /* ── Step 3: Invite ───────────────────────────────────────── */
  async function submitInvite() {
    setError('')
    if (inviteEmail.trim() && workspaceId) {
      setLoading(true)
      try {
        const res  = await fetch('/api/team/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: inviteEmail, workspaceId }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          // FIX: this used to be a fire-and-forget .catch(() => {}) that
          // swallowed any error (invalid email, etc.) and silently advanced
          // to the next step regardless — the person had no idea nothing
          // was sent. Now a failed invite blocks advancing and shows why.
          setError(json.error || 'Could not send that invite — check the email address, or skip this step.')
          return
        }
      } finally { setLoading(false) }
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
      clearSavedProgress()
      router.push('/dashboard')
    } finally { setLoading(false) }
  }

  // FIX (deep audit, Workspace lifecycle + Onboarding sections): brief
  // blank beat while onboarding-status resolves, rather than flashing
  // Step 1 of the wizard (and its "Continue" button) for a split second
  // before possibly redirecting into 'waiting' or 'complete'.
  if (gate === 'loading') {
    return <div className="ob-root"><div className="ob-card" /></div>
  }

  if (gate === 'waiting') {
    return (
      <div className="ob-root">
        <div className="ob-card" style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ width: 64, height: 64, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className="ti ti-hourglass" style={{ fontSize: 28, color: 'var(--text-3)' }} />
          </div>
          <h2 className="ob-title" style={{ textAlign: 'center' }}>Almost there</h2>
          <p className="ob-sub" style={{ textAlign: 'center', marginBottom: 28 }}>
            You've joined <strong style={{ color: 'var(--text)' }}>{waitingFor?.agencyName}</strong> on ScopeGov,
            but {waitingFor?.creatorName} hasn't finished setting up the workspace yet. Once they do, you'll
            get full access automatically — no need to do anything here.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 280, margin: '0 auto' }}>
            <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => supabase.auth.signOut().then(() => router.push('/login'))}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    )
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
              <button className="ob-skip" onClick={() => setStep(0)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Back
              </button>
              <div style={{ flex: 1 }} />
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
            {error && <div className="auth-error">{error}</div>}

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
              <label className="flbl">Governing law <span className="fhint">— the contract law that governs your SOWs</span></label>
              <input className="finp" value={governingLaw}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGoverningLaw(e.target.value)}
                placeholder="e.g. Republic of Kenya" />
            </div>

            <div className="ob-nav">
              <button className="ob-skip" onClick={() => setStep(1)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Back
              </button>
              <div style={{ flex: 1 }} />
              <button className="ob-skip" onClick={() => setStep(3)}>Skip</button>
              <button className="btn btn-primary" onClick={submitDefaults} disabled={loading}>
                {loading ? <span className="spin" /> : <>Continue <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /></>}
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
            {error && <div className="auth-error">{error}</div>}

            <div className="ob-nav">
              <button className="ob-skip" onClick={() => setStep(2)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Back
              </button>
              <div style={{ flex: 1 }} />
              <button className="ob-skip" onClick={() => { setError(''); setStep(4) }}>Skip for now</button>
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
