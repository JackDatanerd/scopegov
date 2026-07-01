'use client'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { SessionUser } from '@/lib/supabase/types'
import { PLAN_LABELS, PLAN_LIMITS, formatDate, formatCurrency } from '@/lib/utils/format'

type SettingsTab = 'account' | 'workspace' | 'branding' | 'defaults' | 'guardian' | 'billing' | 'notifications' | 'integrations' | 'danger'

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'account',       label: 'Account' },
  { key: 'workspace',     label: 'Workspace' },
  { key: 'branding',      label: 'Branding' },
  { key: 'defaults',      label: 'Defaults' },
  { key: 'guardian',      label: 'Guardian' },
  { key: 'billing',       label: 'Billing' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'integrations',  label: 'Integrations' },
  { key: 'danger',        label: 'Danger zone' },
]

interface Props {
  workspace:   any
  billing:     any
  defaults:    any
  logoUrl:     string | null
  session:     SessionUser
  permissions: { manageWorkspace: boolean; manageBilling: boolean; viewAuditLog: boolean; exportData: boolean; manageRoles: boolean }
}

export default function SettingsClient({ workspace, billing, defaults, logoUrl, session, permissions }: Props) {
  const searchParams = useSearchParams()
  const router       = useRouter()
  const supabase     = createClient()
  const [tab,        setTab]        = useState<SettingsTab>((searchParams.get('tab') as SettingsTab) || 'account')
  const [saving,     setSaving]     = useState(false)
  const [saved,      setSaved]      = useState(false)
  const [error,      setError]      = useState('')

  function save(msg?: string) { setSaved(true); setTimeout(() => setSaved(false), 2000) }

  async function patch(path: string, body: any) {
    setSaving(true); setError('')
    try {
      const res  = await fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      save(); router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div className="settings-layout">
      {/* Sidebar nav */}
      <div>
        <div className="settings-nav">
          {TABS.map(t => (
            <button key={t.key}
              className={`settings-nav-item${tab === t.key ? ' active' : ''}${t.key === 'danger' ? ' set-tab-danger' : ''}`}
              onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div>
        {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}
        {saved && <div className="auth-success" style={{ marginBottom: 14 }}>Changes saved.</div>}

        {tab === 'account'   && <AccountTab session={session} supabase={supabase} router={router} />}
        {tab === 'workspace' && <WorkspaceTab workspace={workspace} permissions={permissions} onSave={patch} saving={saving} />}
        {tab === 'branding'  && <BrandingTab workspace={workspace} logoUrl={logoUrl} permissions={permissions} onSave={patch} saving={saving} />}
        {tab === 'defaults'  && <DefaultsTab defaults={defaults} permissions={permissions} onSave={patch} saving={saving} />}
        {tab === 'guardian'  && <GuardianTab workspace={workspace} permissions={permissions} onSave={patch} saving={saving} />}
        {tab === 'billing'   && <BillingTab workspace={workspace} billing={billing} session={session} permissions={permissions} />}
        {tab === 'notifications' && <NotificationsTab />}
        {tab === 'integrations'  && <IntegrationsTab session={session} />}
        {tab === 'danger'        && <DangerTab workspace={workspace} permissions={permissions} />}
      </div>
    </div>
  )
}

// ── ACCOUNT ──────────────────────────────────────────────────
function AccountTab({ session, supabase, router }: any) {
  const [name,        setName]        = useState(session.name)
  const [currentPw,   setCurrentPw]   = useState('')
  const [newPw,       setNewPw]       = useState('')
  const [confirmPw,   setConfirmPw]   = useState('')
  const [pwLoading,   setPwLoading]   = useState(false)
  const [nameLoading, setNameLoading] = useState(false)
  const [msg,         setMsg]         = useState('')
  const [err,         setErr]         = useState('')

  async function saveName(e: React.FormEvent) {
    e.preventDefault()
    setNameLoading(true); setMsg(''); setErr('')
    try {
      await supabase.auth.updateUser({ data: { name } })
      const res = await fetch('/api/workspace/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      if (res.ok) { setMsg('Name updated.'); router.refresh() }
    } catch { setErr('Failed to update name') } finally { setNameLoading(false) }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    if (newPw !== confirmPw) { setErr('Passwords do not match'); return }
    if (newPw.length < 8)    { setErr('Password must be at least 8 characters'); return }
    setPwLoading(true); setMsg(''); setErr('')
    try {
      const { error } = await supabase.auth.updateUser({ password: newPw })
      if (error) throw error
      setMsg('Password updated. Please sign in again.') // spec §16.2: all sessions invalidated
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      await supabase.auth.signOut()
      router.push('/login?message=Password+updated.+Please+sign+in+again.')
    } catch (e: any) { setErr(e.message) } finally { setPwLoading(false) }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Account settings</h2>
      {msg && <div className="auth-success" style={{ marginBottom: 14 }}>{msg}</div>}
      {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

      <div className="settings-section">
        <div className="settings-section-title">Profile</div>
        <form onSubmit={saveName}>
          <div className="f2" style={{ marginBottom: 14 }}>
            <div className="fgrp">
              <label className="flbl">Full name</label>
              <input className="finp" value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
            </div>
            <div className="fgrp">
              <label className="flbl">Email address</label>
              <input className="finp" value={session.email} disabled />
            </div>
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={nameLoading || !name.trim()}>
            {nameLoading ? <span className="spin" /> : 'Save name'}
          </button>
        </form>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Change password</div>
        <form onSubmit={savePassword}>
          <div className="fgrp">
            <label className="flbl">New password <span className="fhint">— 8 characters minimum</span></label>
            <input type="password" className="finp" value={newPw} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPw(e.target.value)} placeholder="New password" autoComplete="new-password" />
          </div>
          <div className="fgrp">
            <label className="flbl">Confirm new password</label>
            <input type="password" className={`finp${confirmPw && confirmPw !== newPw ? ' err' : ''}`}
              value={confirmPw} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPw(e.target.value)} placeholder="Repeat password" autoComplete="new-password" />
            {confirmPw && confirmPw !== newPw && <p className="ferr">Passwords don&apos;t match.</p>}
          </div>
          <button type="submit" className="btn btn-primary btn-sm"
            disabled={pwLoading || !newPw || !confirmPw || newPw !== confirmPw}>
            {pwLoading ? <span className="spin" /> : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── WORKSPACE ─────────────────────────────────────────────────
function WorkspaceTab({ workspace, permissions, onSave, saving }: any) {
  const [name,         setName]         = useState(workspace?.name || '')
  const [agencyName,   setAgencyName]   = useState(workspace?.agency_name || '')
  const [industry,     setIndustry]     = useState(workspace?.industry || '')
  const [timezone,     setTimezone]     = useState(workspace?.timezone || '')
  const [currency,     setCurrency]     = useState(workspace?.currency || 'USD')
  const [governingLaw, setGoverningLaw] = useState(workspace?.governing_law || '')

  if (!permissions.manageWorkspace) {
    return <Restricted />
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Workspace settings</h2>
      <div className="settings-section">
        <div className="settings-section-title">Identity</div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Workspace name</label>
            <input className="finp" value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
          </div>
          <div className="fgrp">
            <label className="flbl">Agency name <span className="fhint">(on documents)</span></label>
            <input className="finp" value={agencyName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAgencyName(e.target.value)} />
          </div>
        </div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Industry</label>
            <input className="finp" value={industry} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIndustry(e.target.value)} />
          </div>
          <div className="fgrp">
            <label className="flbl">Default currency</label>
            <select className="finp" value={currency} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCurrency(e.target.value)}>
              {['USD','KES','GBP','EUR','ZAR','NGN','GHS','AED'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Timezone</label>
            <input className="finp" value={timezone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTimezone(e.target.value)} />
          </div>
          <div className="fgrp">
            <label className="flbl">Governing law (default)</label>
            <input className="finp" value={governingLaw} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGoverningLaw(e.target.value)} />
          </div>
        </div>
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => onSave('/api/workspace/settings', { name, agencyName, industry, timezone, currency, governingLaw })}>
          {saving ? <span className="spin" /> : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

// ── BRANDING ──────────────────────────────────────────────────
function BrandingTab({ workspace, logoUrl, permissions, onSave, saving }: any) {
  const [colour,    setColour]    = useState(workspace?.brand_colour || '#1A5C3A')
  const [logoFile,  setLogoFile]  = useState<File | null>(null)
  const [preview,   setPreview]   = useState<string | null>(logoUrl)
  const [uploading, setUploading] = useState(false)
  const supabase = createClient()

  if (!permissions.manageWorkspace) return <Restricted />

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!['image/png','image/jpeg','image/svg+xml'].includes(file.type)) return
    setLogoFile(file)
    const reader = new FileReader()
    reader.onload = ev => setPreview(ev.target?.result as string)
    reader.readAsDataURL(file)
  }

  async function saveBranding() {
    setUploading(true)
    try {
      let logoStoragePath: string | undefined
      if (logoFile) {
        const ext  = logoFile.name.split('.').pop()
        const path = `${workspace.id}/logo.${ext}`
        const { error } = await (supabase as any).storage.from('logos').upload(path, logoFile, { upsert: true })
        if (!error) logoStoragePath = path
      }
      await onSave('/api/workspace/branding', { brandColour: colour, ...(logoStoragePath ? { logoStoragePath } : {}) })
    } finally { setUploading(false) }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Branding</h2>
      <div className="settings-section">
        <div className="settings-section-title">Agency logo & colour</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <div style={{ width: 72, height: 72, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {preview
              ? <img src={preview} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              : <i className="ti ti-building" style={{ fontSize: 28, color: 'var(--text-4)' }} />}
          </div>
          <div>
            <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
              <i className="ti ti-upload" style={{ fontSize: 12 }} /> {logoFile ? 'Change logo' : 'Upload logo'}
              <input type="file" accept="image/png,image/jpeg,image/svg+xml" style={{ display: 'none' }} onChange={handleLogoChange} />
            </label>
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>PNG, JPEG, or SVG · Max 2 MB</p>
          </div>
        </div>
        <div className="fgrp">
          <label className="flbl">Brand colour</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="color" value={colour} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setColour(e.target.value)}
              style={{ width: 40, height: 38, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: 2 }} />
            <input className="finp" value={colour} style={{ width: 120 }}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setColour(e.target.value)} placeholder="#1A5C3A" />
            <div style={{ width: 38, height: 38, background: colour, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }} />
          </div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={saveBranding} disabled={saving || uploading}>
          {saving || uploading ? <span className="spin" /> : 'Save branding'}
        </button>
      </div>
    </div>
  )
}

// ── DEFAULTS ──────────────────────────────────────────────────
function DefaultsTab({ defaults, permissions, onSave, saving }: any) {
  const [revRounds,    setRevRounds]    = useState(String(defaults?.revision_rounds || 2))
  const [payStructure, setPayStructure] = useState(defaults?.payment_structure || '50_50')
  const [govLaw,       setGovLaw]       = useState(defaults?.governing_law || 'Republic of Kenya')

  if (!permissions.manageWorkspace) return <Restricted />

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>SOW defaults</h2>
      <div className="settings-section">
        <div className="settings-section-title">Default SOW settings</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 18, lineHeight: 1.6 }}>
          These values pre-fill every new Statement of Work. You can override them per project.
        </p>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Default revision rounds</label>
            <select className="finp" value={revRounds} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRevRounds(e.target.value)}>
              {['1','2','3','4','5'].map(n => <option key={n} value={n}>{n} round{n !== '1' ? 's' : ''}</option>)}
            </select>
          </div>
          <div className="fgrp">
            <label className="flbl">Default payment structure</label>
            <select className="finp" value={payStructure} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPayStructure(e.target.value)}>
              <option value="50_50">50% upfront / 50% on delivery</option>
              <option value="100_upfront">100% upfront</option>
              <option value="milestones">Milestone-based</option>
              <option value="monthly">Monthly retainer</option>
              <option value="on_delivery">100% on delivery</option>
            </select>
          </div>
        </div>
        <div className="fgrp">
          <label className="flbl">Default governing law</label>
          <input className="finp" value={govLaw} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGovLaw(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => onSave('/api/workspace/defaults', { revisionRounds: parseInt(revRounds), paymentStructure: payStructure, governingLaw: govLaw })}>
          {saving ? <span className="spin" /> : 'Save defaults'}
        </button>
      </div>
    </div>
  )
}

// ── GUARDIAN ──────────────────────────────────────────────────
function GuardianTab({ workspace, permissions, onSave, saving }: any) {
  const [sensitivity, setSensitivity] = useState(workspace?.guardian_sensitivity_tier || 'medium')
  const [riskEnabled, setRiskEnabled] = useState(workspace?.proactive_risk_alerts_enabled ?? true)
  const [riskThreshold, setRiskThreshold] = useState(String(workspace?.proactive_risk_threshold || 10000))

  if (!permissions.manageWorkspace) return <Restricted />

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Guardian settings</h2>
      <div className="settings-section">
        <div className="settings-section-title">Classification sensitivity</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 18, lineHeight: 1.6 }}>
          Controls how aggressively Guardian flags potential scope creep. Higher sensitivity catches more — and may produce more borderline flags.
        </p>
        <div className="fgrp">
          <label className="flbl">Sensitivity tier</label>
          <select className="finp" value={sensitivity} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSensitivity(e.target.value)}>
            <option value="conservative">Conservative — only flag high-confidence violations (threshold: 0.92)</option>
            <option value="medium">Medium (default) — balanced detection (threshold: 0.85)</option>
            <option value="aggressive">Aggressive — flag borderline cases early (threshold: 0.78)</option>
          </select>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">Proactive risk alerts</div>
        <div className="settings-row">
          <div>
            <div className="settings-row-key">Proactive risk alerts</div>
            <div className="settings-row-desc">Flag high-value projects that don&apos;t have a signed SOW yet.</div>
          </div>
          <button className={`toggle ${riskEnabled ? 'on' : 'off'}`} onClick={() => setRiskEnabled(!riskEnabled)} />
        </div>
        {riskEnabled && (
          <div className="fgrp" style={{ marginTop: 12 }}>
            <label className="flbl">Contract value threshold</label>
            <input type="number" className="finp" style={{ maxWidth: 200 }} value={riskThreshold}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRiskThreshold(e.target.value)} min={0} />
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>Alert when a project over this value has no signed SOW.</p>
          </div>
        )}
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => onSave('/api/workspace/settings', {
            guardianSensitivityTier: sensitivity,
            proactiveRiskAlertsEnabled: riskEnabled,
            proactiveRiskThreshold: parseFloat(riskThreshold) || 10000,
          })}>
          {saving ? <span className="spin" /> : 'Save settings'}
        </button>
      </div>
    </div>
  )
}

// ── BILLING ───────────────────────────────────────────────────
function BillingTab({ workspace, billing, session, permissions }: any) {
  const planTier   = workspace?.plan_tier || 'trial'
  const planLabel  = PLAN_LABELS[planTier] || planTier
  const limits     = PLAN_LIMITS[planTier]
  const daysLeft   = workspace?.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(workspace.trial_ends_at).getTime() - Date.now()) / 86400000))
    : null

  if (!permissions.manageBilling) return <Restricted />

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Billing & plan</h2>

      {/* Current plan */}
      <div className="settings-section" style={{ marginBottom: 14 }}>
        <div className="settings-section-title">Current plan</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 20, fontFamily: 'Cormorant Garamond, Georgia, serif', fontWeight: 400, color: 'var(--green)', marginBottom: 3 }}>{planLabel}</div>
            {planTier === 'trial' && daysLeft !== null && (
              <div style={{ fontSize: 13, color: 'var(--amber)' }}>{daysLeft} trial days remaining</div>
            )}
            {billing?.current_period_end && (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Renews {formatDate(billing.current_period_end)}</div>
            )}
          </div>
          {planTier !== 'agency' && (
            <button className="btn btn-primary btn-sm">Upgrade plan</button>
          )}
        </div>
        {billing?.payment_method_last4 && (
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
            <i className="ti ti-credit-card" style={{ marginRight: 6 }} />
            {billing.payment_method_type} ending {billing.payment_method_last4}
          </div>
        )}
        {billing?.cancels_at_period_end && (
          <div className="banner banner-warn" style={{ marginTop: 12 }}>
            <span>Subscription cancelled — access until {formatDate(billing.current_period_end)}</span>
          </div>
        )}
      </div>

      {/* Plan tiers */}
      <div className="settings-section">
        <div className="settings-section-title">Available plans</div>
        <div className="tier-cards">
          {[
            { key: 'solo',    name: 'Solo',    price: '$39/mo',  seats: 1,  projects: 2 },
            { key: 'starter', name: 'Starter', price: '$99/mo',  seats: 2,  projects: 5 },
            { key: 'pro',     name: 'Pro',     price: '$249/mo', seats: 4,  projects: null },
            { key: 'agency',  name: 'Agency',  price: '$399/mo', seats: 10, projects: null },
          ].map(plan => (
            <div key={plan.key} className={`tier-card${planTier === plan.key ? ' current' : ''}`}>
              <div className="tier-card-name">{plan.name}</div>
              <div className="tier-card-price">{plan.price}</div>
              <div className="tier-card-desc">
                {plan.seats} seat{plan.seats > 1 ? 's' : ''} · {plan.projects ? `${plan.projects} projects` : 'Unlimited projects'}
              </div>
              {planTier !== plan.key && (
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}>
                  {plan.key === 'solo' || PLAN_LIMITS[planTier]?.seats > PLAN_LIMITS[plan.key]?.seats ? 'Downgrade' : 'Upgrade'}
                </button>
              )}
              {planTier === plan.key && (
                <div style={{ marginTop: 12, fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>Current plan</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── NOTIFICATIONS ─────────────────────────────────────────────
function NotificationsTab() {
  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Notifications</h2>
      <div className="settings-section">
        <div className="settings-section-title">Email notifications</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>
          Email notification preferences are managed per-event and can be configured by workspace owners.
          Individual preferences can be overridden unless the workspace owner has locked a notification type.
        </p>
        {[
          { label: 'SOW signed by client', desc: 'When your client signs a Statement of Work' },
          { label: 'SOW declined', desc: 'When a client declines to sign' },
          { label: 'Change order accepted', desc: 'When a client accepts a change order' },
          { label: 'Change order declined', desc: 'When a client declines a change order' },
          { label: 'Scope flag raised', desc: 'When Guardian detects an out-of-scope request' },
          { label: 'Escalation', desc: 'When a matter is escalated to you' },
          { label: 'Trial ending', desc: '3 days before trial expires' },
        ].map(item => (
          <div key={item.label} className="settings-row">
            <div>
              <div className="settings-row-key">{item.label}</div>
              <div className="settings-row-desc">{item.desc}</div>
            </div>
            <button className="toggle on" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── INTEGRATIONS ──────────────────────────────────────────────
function IntegrationsTab({ session }: { session: SessionUser }) {
  const canSlack  = ['pro','agency','trial'].includes(session.planTier)
  const canZapier = canSlack

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Integrations</h2>
      <div className="settings-section">
        {[
          { name: 'Slack',   icon: 'ti-brand-slack',  desc: 'Auto-create a channel per project for Guardian monitoring',  avail: canSlack, plan: 'Pro' },
          { name: 'Zapier',  icon: 'ti-bolt',         desc: 'Connect ScopeGov to 5,000+ apps via Zapier',                avail: canZapier, plan: 'Pro' },
          { name: 'HubSpot', icon: 'ti-circle-dashed', desc: 'Sync clients and project status with HubSpot CRM',          avail: session.planTier === 'agency', plan: 'Agency' },
          { name: 'Google Drive', icon: 'ti-brand-google-drive', desc: 'Attach Drive files to SOWs and change orders',  avail: session.planTier === 'agency', plan: 'Agency' },
        ].map(int => (
          <div key={int.name} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--surface-2)' }}>
            <div style={{ width: 36, height: 36, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <i className={`ti ${int.icon}`} style={{ fontSize: 18, color: 'var(--text-2)' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{int.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{int.desc}</div>
            </div>
            {int.avail ? (
              <button className="btn btn-ghost btn-sm">Connect</button>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--text-3)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px' }}>
                {int.plan}+ only
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── DANGER ZONE ───────────────────────────────────────────────
function DangerTab({ workspace, permissions }: any) {
  const [confirm, setConfirm] = useState('')

  if (!permissions.manageWorkspace) return <Restricted />

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, color: 'var(--red)', marginBottom: 20 }}>Danger zone</h2>
      <div className="settings-section" style={{ border: '1px solid #FECACA' }}>
        <div className="settings-section-title" style={{ color: 'var(--red)' }}>Delete workspace</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 16 }}>
          Permanently delete this workspace and all its data. This cannot be undone.
          <strong> Workspaces with signed documents cannot be deleted.</strong>
          Your data is retained for 7 years for legal compliance before permanent removal.
        </p>
        <div className="fgrp">
          <label className="flbl">Type <strong>{workspace?.name}</strong> to confirm</label>
          <input className="finp err" value={confirm} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirm(e.target.value)} placeholder={workspace?.name} />
        </div>
        <button className="btn btn-danger btn-sm" disabled={confirm !== workspace?.name}>
          Delete workspace permanently
        </button>
      </div>
    </div>
  )
}

function Restricted() {
  return (
    <div className="surface surface-p" style={{ textAlign: 'center', padding: 48 }}>
      <i className="ti ti-lock" style={{ fontSize: 28, color: 'var(--text-4)', display: 'block', marginBottom: 12 }} />
      <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-2)', marginBottom: 6 }}>Access restricted</p>
      <p style={{ fontSize: 12, color: 'var(--text-3)' }}>You need the MANAGE_WORKSPACE_SETTINGS permission to view this section.</p>
    </div>
  )
}
