// components/settings/SettingsClient.tsx
// Fix: ALL tab form state lifted to this parent component (which never
// unmounts during tab switching). Previously each tab (Workspace, Branding,
// Defaults, Guardian, Notifications) held its own useState seeded from the
// `workspace`/`defaults` prop. Switching tabs unmounts the tab component;
// switching back remounts it and re-reads whatever prop value existed at
// that instant. If router.refresh() hadn't finished fetching yet, the user
// saw a stale value — even though the save itself succeeded. Lifting the
// state here means it survives tab switches regardless of refresh timing.

'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { SessionUser } from '@/lib/supabase/types'
import { PLAN_LABELS, PLAN_LIMITS, formatDate } from '@/lib/utils/format'
import SignaturePad, { type SignaturePadHandle } from '@/components/ui/SignaturePad'
import MfaSection from '@/components/settings/MfaSection'
import { permissionsRequireMfa } from '@/lib/auth/mfa-policy'

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

const NOTIF_ITEMS = [
  { key: 'sow_signed',            label: 'SOW signed by client',    desc: 'When your client signs a Statement of Work' },
  { key: 'sow_declined',          label: 'SOW declined',            desc: 'When a client declines to sign' },
  { key: 'sow_changes_requested', label: 'SOW changes requested',   desc: 'When a client requests changes to a Statement of Work' },
  { key: 'co_accepted',           label: 'Change order accepted',   desc: 'When a client accepts a change order' },
  { key: 'co_declined',           label: 'Change order declined',   desc: 'When a client declines a change order' },
  { key: 'co_countered',          label: 'Change order countered',  desc: 'When a client proposes a different amount' },
  { key: 'guardian_flag',         label: 'Scope flag raised',       desc: 'When Guardian detects an out-of-scope request' },
  { key: 'escalation',            label: 'Escalation',              desc: 'When a matter is escalated to you' },
  // FIX (audit): these three were fully wired server-side but had no toggle here,
  // so they were permanently on with no way to mute them.
  { key: 'invoice_payment_received', label: 'Invoice payment received', desc: 'When a client pays an invoice, in full or in part' },
  { key: 'invoice_overdue',       label: 'Invoice overdue',         desc: 'When an invoice passes its due date unpaid' },
  { key: 'approval_requested',    label: 'Approval requested',      desc: 'When a document needs your approval' },
  { key: 'trial_ending',          label: 'Trial ending',            desc: '3 days before trial expires' },
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
  const [tab,    setTab]    = useState<SettingsTab>((searchParams.get('tab') as SettingsTab) || 'account')
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState('')

  // ── Lifted form state (all seeded once via lazy init; never reset by remounts) ──
  const [wsForm, setWsForm] = useState(() => ({
    name:         workspace?.name || '',
    agencyName:   workspace?.agency_name || '',
    industry:     workspace?.industry || '',
    timezone:     workspace?.timezone || '',
    currency:     workspace?.currency || 'USD',
    governingLaw: workspace?.governing_law || '',
    slug:         workspace?.slug || '',
    // Phase 11 — document billing identity. Printed on every SOW/CO/Invoice
    // PDF as the agency's "From" block; all optional, PDFs render fine
    // without them, they just omit the address/tax-ID lines.
    taxId:                      workspace?.tax_id || '',
    phone:                      workspace?.phone || '',
    website:                    workspace?.website || '',
    defaultPaymentInstructions: workspace?.default_payment_instructions || '',
    legalAddress: {
      line1:      workspace?.legal_address?.line1 || '',
      line2:      workspace?.legal_address?.line2 || '',
      city:       workspace?.legal_address?.city || '',
      region:     workspace?.legal_address?.region || '',
      postalCode: workspace?.legal_address?.postalCode || '',
      country:    workspace?.legal_address?.country || '',
    },
  }))
  // FIX: no UI existed anywhere for the workspace slug despite full,
  // working backend support (including the once-only change lock).
  const slugLocked = !!workspace?.slug_changed_at

  const [brandColour, setBrandColour] = useState(() => workspace?.brand_colour || '#1A5C3A')
  const [logoPreview, setLogoPreview] = useState<string | null>(logoUrl)

  const [defaultsForm, setDefaultsForm] = useState(() => ({
    revRounds:    String(defaults?.revision_rounds || 2),
    payStructure: defaults?.payment_structure || '50_50',
    // FIX (doc-completeness audit, finding #1): governing law used to be a
    // second, independent field here (workspace_defaults.governing_law)
    // that SOW generation never actually read — agencies would fill this
    // in during onboarding, see it "saved," and every SOW would silently
    // use the fallback country instead. There's now exactly one governing
    // law field, on the Workspace tab, writing straight to
    // workspaces.governing_law (the field SOW generation actually reads).
  }))

  const [guardianForm, setGuardianForm] = useState(() => ({
    sensitivity:   workspace?.guardian_sensitivity_tier || 'medium',
    riskEnabled:   workspace?.proactive_risk_alerts_enabled ?? true,
    riskThreshold: String(workspace?.proactive_risk_threshold || 10000),
  }))


  async function patch(path: string, body: any) {
    setSaving(true); setError('')
    try {
      const res  = await fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
      router.refresh()
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed')
      return false
    } finally { setSaving(false) }
  }

  return (
    <div className="settings-layout">
      <div>
        <div className="settings-nav">
          {TABS.map(t => (
            <button key={t.key}
              className={`settings-nav-item${tab === t.key ? ' active' : ''}${t.key === 'danger' ? ' set-tab-danger' : ''}`}
              onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
          {/* FIX: /settings/audit was fully built (permission-gated, reads
              from audit_log) but had no link anywhere in this nav — it was
              only reachable by typing the URL directly. */}
          {permissions.viewAuditLog && (
            <Link href="/settings/audit" className="settings-nav-item">Audit log</Link>
          )}
          {/* Phase 3 — Approval Chains config lives on its own page (same
              reasoning as audit log above: a dynamic step-builder doesn't
              fit the flat form-field pattern the other tabs use). */}
          {permissions.manageWorkspace && (
            <Link href="/settings/approvals" className="settings-nav-item">Approval workflows</Link>
          )}
        </div>
      </div>
      <div>
        {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}
        {saved && <div className="auth-success" style={{ marginBottom: 14 }}>Changes saved.</div>}

        {tab === 'account' && <AccountTab session={session} supabase={supabase} router={router} />}

        {tab === 'workspace' && (
          <WorkspaceTab form={wsForm} setForm={setWsForm} permissions={permissions} onSave={patch} saving={saving} slugLocked={slugLocked} />
        )}

        {tab === 'branding' && (
          <BrandingTab
            workspaceId={workspace?.id}
            colour={brandColour} setColour={setBrandColour}
            preview={logoPreview} setPreview={setLogoPreview}
            savedSignature={workspace?.agency_signature_data || null}
            permissions={permissions} onSave={patch} saving={saving}
          />
        )}

        {tab === 'defaults' && (
          <DefaultsTab form={defaultsForm} setForm={setDefaultsForm} permissions={permissions} onSave={patch} saving={saving} setTab={setTab} />
        )}

        {tab === 'guardian' && (
          <GuardianTab form={guardianForm} setForm={setGuardianForm} permissions={permissions} onSave={patch} saving={saving} />
        )}

        {tab === 'billing' && <BillingTab workspace={workspace} billing={billing} session={session} permissions={permissions} />}

        {tab === 'notifications' && <NotificationsTab />}

        {tab === 'integrations' && <IntegrationsTab session={session} />}

        {tab === 'danger' && <DangerTab workspace={workspace} permissions={permissions} />}
      </div>
    </div>
  )
}

// ── ACCOUNT ──────────────────────────────────────────────────
function AccountTab({ session, supabase, router }: any) {
  const [name,        setName]        = useState(session.name)
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
      // FIX (deep audit, section 5): this used to call
      // supabase.auth.updateUser() directly from the browser, with no
      // re-authentication check at all — unlike disabling MFA, which
      // requires proving aal2 first. Route it through a server endpoint
      // that enforces the same rule when this account's role mandates MFA.
      const res = await fetch('/api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPw }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Failed to update password')
      setMsg('Password updated.')
      setNewPw(''); setConfirmPw('')
      await supabase.auth.signOut()
      router.push('/login?message=Password+updated.+Please+sign+in+again.')
    } catch (e: any) { setErr(e.message) } finally { setPwLoading(false) }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Account settings</h2>
      {msg && <div className="auth-success" style={{ marginBottom: 14 }}>{msg}</div>}
      {err && <div className="auth-error"  style={{ marginBottom: 14 }}>{err}</div>}
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
            <input type="password" className="finp" value={newPw}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPw(e.target.value)}
              placeholder="New password" autoComplete="new-password" />
          </div>
          <div className="fgrp">
            <label className="flbl">Confirm new password</label>
            <input type="password" className={`finp${confirmPw && confirmPw !== newPw ? ' err' : ''}`}
              value={confirmPw}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPw(e.target.value)}
              placeholder="Repeat password" autoComplete="new-password" />
            {confirmPw && confirmPw !== newPw && <p className="ferr">Passwords don&apos;t match.</p>}
          </div>
          <button type="submit" className="btn btn-primary btn-sm"
            disabled={pwLoading || !newPw || !confirmPw || newPw !== confirmPw}>
            {pwLoading ? <span className="spin" /> : 'Update password'}
          </button>
        </form>
      </div>
      <MfaSection mandatory={permissionsRequireMfa(session.permissions)} />
    </div>
  )
}

// ── WORKSPACE ─────────────────────────────────────────────────
function WorkspaceTab({ form, setForm, permissions, onSave, saving, slugLocked }: any) {
  if (!permissions.manageWorkspace) return <Restricted />

  function set<K extends string>(key: K, value: string) {
    setForm((f: any) => ({ ...f, [key]: value }))
  }
  function setAddr(key: string, value: string) {
    setForm((f: any) => ({ ...f, legalAddress: { ...f.legalAddress, [key]: value } }))
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Workspace settings</h2>
      <div className="settings-section">
        <div className="settings-section-title">Identity</div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Workspace name <span className="fhint">(internal only — not shown to clients or in the sidebar)</span></label>
            <input className="finp" value={form.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('name', e.target.value)} />
          </div>
          <div className="fgrp">
            <label className="flbl">Agency name <span className="fhint">(on documents)</span></label>
            <input className="finp" value={form.agencyName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('agencyName', e.target.value)} />
          </div>
        </div>
        <div className="fgrp">
          <label className="flbl">
            Workspace slug{' '}
            <span className="fhint">
              {slugLocked ? '(already changed once — locked)' : '(can only be changed once, ever — choose carefully)'}
            </span>
          </label>
          <input className="finp" value={form.slug} disabled={slugLocked}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
        </div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Industry</label>
            <input className="finp" value={form.industry} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('industry', e.target.value)} />
          </div>
          <div className="fgrp">
            <label className="flbl">Default currency</label>
            <select className="finp" value={form.currency} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set('currency', e.target.value)}>
              {['USD','KES','GBP','EUR','ZAR','NGN','GHS','AED'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Timezone</label>
            <input className="finp" value={form.timezone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('timezone', e.target.value)} />
          </div>
          <div className="fgrp">
            <label className="flbl">Governing law</label>
            <input className="finp" value={form.governingLaw} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('governingLaw', e.target.value)}
              placeholder="e.g. Republic of Kenya" />
            <span className="fhint">Used in the governing-law clause on every SOW you send.</span>
          </div>
        </div>
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => onSave('/api/workspace/settings', form)}>
          {saving ? <span className="spin" /> : 'Save changes'}
        </button>
      </div>

      {/* Phase 11: document billing identity — this is what turns a PDF from
          "generated by ScopeGov" into a real business document that belongs
          to the agency. Every field here is optional; the SOW/CO/Invoice
          PDFs render fine without them, they just omit the address/tax-ID/
          remit-to blocks until filled in. */}
      <div className="settings-section">
        <div className="settings-section-title">
          Billing identity <span className="fhint" style={{ fontWeight: 400 }}>— printed on your SOW, Change Order, and Invoice PDFs</span>
        </div>
        <div className="fgrp">
          <label className="flbl">Registered / mailing address</label>
          <input className="finp" style={{ marginBottom: 8 }} value={form.legalAddress.line1}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddr('line1', e.target.value)} placeholder="Address line 1" />
          <input className="finp" value={form.legalAddress.line2}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddr('line2', e.target.value)} placeholder="Address line 2 — optional" />
        </div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">City</label>
            <input className="finp" value={form.legalAddress.city} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddr('city', e.target.value)} />
          </div>
          <div className="fgrp">
            <label className="flbl">Region / State</label>
            <input className="finp" value={form.legalAddress.region} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddr('region', e.target.value)} />
          </div>
        </div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Postal code</label>
            <input className="finp" value={form.legalAddress.postalCode} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddr('postalCode', e.target.value)} />
          </div>
          <div className="fgrp">
            <label className="flbl">Country</label>
            <input className="finp" value={form.legalAddress.country} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddr('country', e.target.value)} />
          </div>
        </div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Tax ID <span className="fhint">— EIN / VAT / company registration</span></label>
            <input className="finp" value={form.taxId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('taxId', e.target.value)} placeholder="87-1046203" />
          </div>
          <div className="fgrp">
            <label className="flbl">Phone <span className="fhint">— optional</span></label>
            <input className="finp" value={form.phone} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('phone', e.target.value)} />
          </div>
        </div>
        <div className="fgrp">
          <label className="flbl">Website <span className="fhint">— optional</span></label>
          <input className="finp" value={form.website} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('website', e.target.value)} placeholder="acme.com" />
        </div>
        <div className="fgrp">
          <label className="flbl">Default payment instructions <span className="fhint">— pre-fills new invoices; wire/ACH details, &ldquo;per PO terms&rdquo;, etc.</span></label>
          <textarea className="finp" rows={3} value={form.defaultPaymentInstructions}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set('defaultPaymentInstructions', e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => onSave('/api/workspace/settings', form)}>
          {saving ? <span className="spin" /> : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

// ── BRANDING ──────────────────────────────────────────────────
function BrandingTab({ workspaceId, colour, setColour, preview, setPreview, savedSignature, permissions, onSave, saving }: any) {
  const [logoFile,  setLogoFile]  = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [fileError, setFileError] = useState('')
  const [sigSaved,   setSigSaved]   = useState<string | null>(savedSignature)
  const [savingSig,  setSavingSig]  = useState(false)
  const [sigError,   setSigError]   = useState('')
  const sigPadRef = useRef<SignaturePadHandle>(null)

  if (!permissions.manageWorkspace) return <Restricted />

  const MAX_LOGO_BYTES = 2 * 1024 * 1024 // 2MB — matches the "Max 2 MB" label already shown in the UI

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileError('')
    // FIX (audit round 5): SVG dropped from accepted types — see
    // app/api/workspace/branding/logo/route.ts for why (unsanitized SVG
    // in a public bucket is a stored-XSS vector). This client-side check
    // is just UX; the server route is the actual enforcement point.
    if (!['image/png','image/jpeg'].includes(file.type)) {
      setFileError('Please upload a PNG or JPG file.')
      e.target.value = ''
      return
    }
    // FIX: no size check existed at all — any file size silently uploaded.
    if (file.size > MAX_LOGO_BYTES) {
      setFileError(`File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max size is 2MB.`)
      e.target.value = ''
      return
    }
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
        // FIX (audit round 3): route the upload through the server so
        // MANAGE_WORKSPACE_SETTINGS and file validation are enforced
        // server-side, not just in this component's render guard. See
        // app/api/workspace/branding/logo/route.ts.
        const body = new FormData()
        body.append('file', logoFile)
        const res  = await fetch('/api/workspace/branding/logo', { method: 'POST', body })
        if (res.ok) {
          const json = await res.json()
          logoStoragePath = json.logoStoragePath
        } else {
          setFileError('Could not upload logo — try again.')
        }
      }
      await onSave('/api/workspace/branding', { brandColour: colour, ...(logoStoragePath ? { logoStoragePath } : {}) })
    } finally { setUploading(false) }
  }

  async function saveSignature() {
    const dataUrl = sigPadRef.current?.toDataURL()
    if (!dataUrl) { setSigError('Draw a signature first.'); return }
    setSigError(''); setSavingSig(true)
    try {
      const res = await fetch('/api/workspace/branding', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencySignatureData: dataUrl }),
      })
      if (!res.ok) throw new Error()
      setSigSaved(dataUrl)
      sigPadRef.current?.clear()
    } catch { setSigError('Could not save signature — try again.') }
    finally { setSavingSig(false) }
  }

  async function clearSavedSignature() {
    setSavingSig(true)
    try {
      const res = await fetch('/api/workspace/branding', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencySignatureData: null }),
      })
      if (res.ok) setSigSaved(null)
    } finally { setSavingSig(false) }
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
              <input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} onChange={handleLogoChange} />
            </label>
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>PNG or JPEG · Max 2 MB</p>
            {fileError && <p className="ferr" style={{ marginTop: 4 }}>{fileError}</p>}
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

      <div className="settings-section" style={{ marginTop: 16 }}>
        <div className="settings-section-title">Your signature</div>
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.6 }}>
          Draw and save your signature once — it&apos;s applied automatically to every SOW and change order you send from here on. This doesn&apos;t change documents already sent or signed.
        </p>
        {sigSaved ? (
          <div>
            <div style={{ display: 'inline-block', background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 16px', marginBottom: 12 }}>
              <img src={sigSaved} alt="Saved signature" style={{ height: 60, display: 'block' }} />
            </div>
            <div>
              <button className="btn btn-ghost btn-sm" onClick={clearSavedSignature} disabled={savingSig}>
                {savingSig ? <span className="spin spin-dark" /> : <><i className="ti ti-trash" style={{ fontSize: 12 }} /> Remove & redraw</>}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ maxWidth: 400 }}>
              <SignaturePad ref={sigPadRef} strokeColour={colour} />
            </div>
            {sigError && <p className="ferr" style={{ marginTop: 6 }}>{sigError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-primary btn-sm" onClick={saveSignature} disabled={savingSig}>
                {savingSig ? <span className="spin" /> : 'Save signature'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => sigPadRef.current?.clear()} disabled={savingSig}>Clear</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── DEFAULTS ──────────────────────────────────────────────────
function DefaultsTab({ form, setForm, permissions, onSave, saving, setTab }: any) {
  if (!permissions.manageWorkspace) return <Restricted />

  function set(key: string, value: string) {
    setForm((f: any) => ({ ...f, [key]: value }))
  }

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
            <select className="finp" value={form.revRounds} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set('revRounds', e.target.value)}>
              {['1','2','3','4','5'].map(n => <option key={n} value={n}>{n} round{n !== '1' ? 's' : ''}</option>)}
            </select>
          </div>
          <div className="fgrp">
            <label className="flbl">Default payment structure</label>
            <select className="finp" value={form.payStructure} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set('payStructure', e.target.value)}>
              <option value="50_50">50% upfront / 50% on delivery</option>
              <option value="100_upfront">100% upfront</option>
              <option value="milestones">Milestone-based</option>
              <option value="monthly">Monthly retainer</option>
              <option value="on_delivery">100% on delivery</option>
            </select>
          </div>
        </div>
        {/* FIX (doc-completeness audit, finding #1): this used to be a
            second, disconnected "Default governing law" input that saved
            to a column SOW generation never read — every SOW silently
            defaulted regardless of what was typed here. Governing law now
            lives in exactly one place. */}
        <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 0, lineHeight: 1.6 }}>
          Governing law is set on the{' '}
          <button type="button" onClick={() => setTab?.('workspace')}
            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--green)', textDecoration: 'underline', cursor: 'pointer' }}>
            Workspace tab
          </button>{' '}and applies to every SOW.
        </p>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} disabled={saving}
          onClick={() => onSave('/api/workspace/defaults', {
            revisionRounds: parseInt(form.revRounds), paymentStructure: form.payStructure,
          })}>
          {saving ? <span className="spin" /> : 'Save defaults'}
        </button>
      </div>
    </div>
  )
}

// ── GUARDIAN ──────────────────────────────────────────────────
function GuardianTab({ form, setForm, permissions, onSave, saving }: any) {
  if (!permissions.manageWorkspace) return <Restricted />

  function set(key: string, value: any) {
    setForm((f: any) => ({ ...f, [key]: value }))
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Guardian settings</h2>
      <div className="settings-section">
        <div className="settings-section-title">Classification sensitivity</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 18, lineHeight: 1.6 }}>
          Controls how aggressively Guardian flags potential scope creep.
        </p>
        <div className="fgrp">
          <label className="flbl">Sensitivity tier</label>
          <select className="finp" value={form.sensitivity} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set('sensitivity', e.target.value)}>
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
          <button className={`toggle ${form.riskEnabled ? 'on' : 'off'}`} onClick={() => set('riskEnabled', !form.riskEnabled)} />
        </div>
        {form.riskEnabled && (
          <div className="fgrp" style={{ marginTop: 12 }}>
            <label className="flbl">Contract value threshold</label>
            <input type="number" className="finp" style={{ maxWidth: 200 }} value={form.riskThreshold}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('riskThreshold', e.target.value)} min={0} />
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>Alert when a project over this value has no signed SOW.</p>
          </div>
        )}
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => onSave('/api/workspace/settings', {
            guardianSensitivityTier: form.sensitivity,
            proactiveRiskAlertsEnabled: form.riskEnabled,
            proactiveRiskThreshold: parseFloat(form.riskThreshold) || 10000,
          })}>
          {saving ? <span className="spin" /> : 'Save settings'}
        </button>
      </div>
    </div>
  )
}

// ── BILLING ───────────────────────────────────────────────────
function BillingTab({ workspace, billing, session, permissions }: any) {
  const planTier  = workspace?.plan_tier || 'trial'
  const planLabel = PLAN_LABELS[planTier] || planTier
  const daysLeft  = workspace?.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(workspace.trial_ends_at).getTime() - Date.now()) / 86400000))
    : null

  const [planInterval, setPlanInterval] = useState<'monthly' | 'annual'>('monthly')
  const [upgrading,    setUpgrading]    = useState<string | null>(null)
  const [cancelling,   setCancelling]   = useState(false)
  const [cancelError,  setCancelError]  = useState('')
  const [justCancelled, setJustCancelled] = useState(false)

  if (!permissions.manageBilling) return <Restricted />

  async function handleCancel() {
    if (!confirm('Cancel your subscription? You\u2019ll keep access until the end of the current billing period, then the workspace will be downgraded.')) return
    setCancelling(true); setCancelError('')
    try {
      const res  = await fetch('/api/billing/cancel', { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (res.ok) { setJustCancelled(true); window.location.reload() }
      else setCancelError(json.error || 'Could not cancel — try again or contact support.')
    } finally { setCancelling(false) }
  }

  async function handleUpgrade(planKey: string) {
    setUpgrading(planKey)
    try {
      const res  = await fetch('/api/billing/upgrade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planKey, interval: planInterval }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      const handler = (window as any).PaystackPop?.setup({
        key:      json.publicKey,
        email:    json.email,
        plan:     json.planCode,
        currency: 'USD',
        metadata: json.metadata,
        callback: () => {
          alert('Payment processing. Your plan will update within a minute.')
          window.location.reload()
        },
        onClose: () => {},
      })
      handler?.openIframe()
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not open checkout')
    } finally { setUpgrading(null) }
  }

  const plans = [
    { key: 'solo',    name: 'Solo',    price: { monthly: '$39/mo',  annual: '$390/yr'  }, seats: 1,  projects: 2    },
    { key: 'starter', name: 'Starter', price: { monthly: '$99/mo',  annual: '$990/yr'  }, seats: 2,  projects: 5    },
    { key: 'pro',     name: 'Pro',     price: { monthly: '$249/mo', annual: '$2,490/yr'}, seats: 4,  projects: null },
    { key: 'agency',  name: 'Agency',  price: { monthly: '$399/mo', annual: '$3,990/yr'}, seats: 10, projects: null },
  ]

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Billing & plan</h2>
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
          {planTier !== 'trial' && !billing?.cancels_at_period_end && (
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
              disabled={cancelling || justCancelled} onClick={handleCancel}>
              {cancelling ? <span className="spin spin-dark" /> : 'Cancel subscription'}
            </button>
          )}
        </div>
        {billing?.cancels_at_period_end && (
          <div className="banner banner-warn" style={{ marginTop: 12 }}>
            <span>Subscription cancelled — access until {formatDate(billing.current_period_end)}</span>
          </div>
        )}
        {cancelError && (
          <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{cancelError}</p>
        )}
      </div>
      <div className="settings-section">
        <div className="settings-section-title">Available plans</div>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', marginBottom: 20 }}>
          {(['monthly', 'annual'] as const).map(iv => (
            <button key={iv} onClick={() => setPlanInterval(iv)}
              style={{
                padding: '7px 16px', fontSize: 12, cursor: 'pointer', border: 'none',
                background: planInterval === iv ? 'var(--green)' : 'transparent',
                color: planInterval === iv ? '#FFF' : 'var(--text-2)',
              }}>
              {iv === 'monthly' ? 'Monthly' : 'Annual · 2 months free'}
            </button>
          ))}
        </div>
        <div className="tier-cards">
          {plans.map(plan => {
            const isCurrent = planTier === plan.key
            const isLoading = upgrading === plan.key
            return (
              <div key={plan.key} className={`tier-card${isCurrent ? ' current' : ''}`}>
                <div className="tier-card-name">{plan.name}</div>
                <div className="tier-card-price">{plan.price[planInterval]}</div>
                <div className="tier-card-desc">
                  {plan.seats} seat{plan.seats > 1 ? 's' : ''} · {plan.projects ? `${plan.projects} projects` : 'Unlimited projects'}
                </div>
                {isCurrent ? (
                  <div style={{ marginTop: 12, fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>Current plan</div>
                ) : (
                  <button className="btn btn-ghost btn-sm"
                    style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}
                    disabled={!!upgrading}
                    onClick={() => handleUpgrade(plan.key)}>
                    {isLoading ? <span className="spin spin-dark" /> : (
                      (PLAN_LIMITS[planTier]?.seats || 0) > (PLAN_LIMITS[plan.key]?.seats || 0) ? 'Downgrade' : 'Upgrade'
                    )}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── NOTIFICATIONS ─────────────────────────────────────────────
function NotificationsTab() {
  const [prefs,   setPrefs]   = useState<Record<string, boolean> | null>(null)
  const [saving,  setSaving]  = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState('')

  useEffect(() => {
    fetch('/api/notifications/preferences')
      .then(r => r.json())
      .then(json => {
        if (json.error) throw new Error(json.error)
        setPrefs(json.prefs)
      })
      .catch(() => setLoadErr('Could not load notification preferences.'))
  }, [])

  async function toggle(key: string) {
    if (!prefs) return
    const next = !prefs[key]
    setPrefs(p => ({ ...(p || {}), [key]: next })) // optimistic
    setSaving(key)
    try {
      const res = await fetch('/api/notifications/preferences', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: key, enabled: next }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setPrefs(p => ({ ...(p || {}), [key]: !next })) // revert on failure
    } finally { setSaving(null) }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Notifications</h2>
      <div className="settings-section">
        <div className="settings-section-title">Email notifications</div>
        {loadErr && <p className="ferr">{loadErr}</p>}
        {!prefs && !loadErr && <p style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</p>}
        {prefs && NOTIF_ITEMS.map(item => (
          <div key={item.key} className="settings-row">
            <div>
              <div className="settings-row-key">{item.label}</div>
              <div className="settings-row-desc">{item.desc}</div>
            </div>
            <button
              className={`toggle ${prefs[item.key] ? 'on' : 'off'}`}
              disabled={saving === item.key}
              onClick={() => toggle(item.key)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── INTEGRATIONS ──────────────────────────────────────────────
function IntegrationsTab({ session }: { session: SessionUser }) {
  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Integrations</h2>
      <div className="settings-section">
        {[
          { name: 'Slack',        icon: 'ti-brand-slack',        desc: 'Auto-create a channel per project for Guardian monitoring' },
          { name: 'Zapier',       icon: 'ti-bolt',               desc: 'Connect ScopeGov to 5,000+ apps via Zapier' },
          { name: 'HubSpot',      icon: 'ti-circle-dashed',      desc: 'Sync clients and project status with HubSpot CRM' },
          { name: 'Google Drive', icon: 'ti-brand-google-drive', desc: 'Attach Drive files to SOWs and change orders' },
        ].map(int => (
          <div key={int.name} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--surface-2)' }}>
            <div style={{ width: 36, height: 36, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <i className={`ti ${int.icon}`} style={{ fontSize: 18, color: 'var(--text-2)' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{int.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{int.desc}</div>
            </div>
            {/* FIX: these were plan-gated 'Connect' buttons with no onClick
                at all — clicking did nothing, no matter the plan. None of
                these integrations are built yet, so show that honestly
                instead of a dead button that looks live. */}
            <span style={{ fontSize: 11, color: 'var(--text-3)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px' }}>Coming soon</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── DANGER ZONE ───────────────────────────────────────────────
function DangerTab({ workspace, permissions }: any) {
  const router   = useRouter()
  const supabase = createClient()
  const [confirm,  setConfirm]  = useState('')
  const [deleting, setDeleting] = useState(false)
  const [err,      setErr]      = useState('')

  if (!permissions.manageWorkspace) return <Restricted />

  async function handleDelete() {
    if (confirm !== workspace?.name) return
    setDeleting(true); setErr('')
    try {
      const res  = await fetch('/api/workspace/delete', { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      await supabase.auth.signOut()
      router.push('/login?message=Workspace+deleted.')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not delete workspace')
    } finally { setDeleting(false) }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, color: 'var(--red)', marginBottom: 20 }}>Danger zone</h2>
      {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="settings-section" style={{ border: '1px solid #FECACA' }}>
        <div className="settings-section-title" style={{ color: 'var(--red)' }}>Delete workspace</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 16 }}>
          Permanently delete this workspace and all its data. This cannot be undone.
          <strong> Workspaces with signed documents cannot be deleted.</strong>
          Your data is retained for 7 years for legal compliance before permanent removal.
        </p>
        <div className="fgrp">
          <label className="flbl">Type <strong>{workspace?.name}</strong> to confirm</label>
          <input className="finp err" value={confirm}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirm(e.target.value)}
            placeholder={workspace?.name} />
        </div>
        <button className="btn btn-danger btn-sm"
          disabled={confirm !== workspace?.name || deleting}
          onClick={handleDelete}>
          {deleting ? <span className="spin" /> : 'Delete workspace permanently'}
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
