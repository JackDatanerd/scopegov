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
import { fetchWithStepUp } from '@/lib/client/step-up'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { SessionUser } from '@/lib/supabase/types'
import { PLAN_LABELS, PLAN_LIMITS, PROJECT_TYPE_LABELS, formatDate, formatCurrency, initials, avatarColour } from '@/lib/utils/format'
import SignaturePad, { type SignaturePadHandle } from '@/components/ui/SignaturePad'
import MfaSection from '@/components/settings/MfaSection'
import SessionsSection from '@/components/settings/SessionsSection'
import ChangeEmailSection from '@/components/settings/ChangeEmailSection'
// FIX (deep audit, Settings re-pass): WorkspaceTab's currency <select> used
// to hardcode its own 8-currency list, missing CAD/AUD — both of which
// onboarding's own currency picker (and server-side validation in
// workspace/settings/route.ts) already allow via this exact constant. A
// workspace onboarded with CAD or AUD landed on a Settings page whose
// dropdown couldn't represent its own saved value: with no matching
// <option>, the browser renders the first option (USD) as selected even
// though the underlying state was still correctly "CAD"/"AUD" — visually
// showing the wrong currency until the person happened to touch the
// field. Import the single source of truth instead of a second,
// drifting copy of the list.
import { CURRENCIES, INDUSTRIES } from '@/lib/constants/workspace-options'
import DocumentNumberingSection from '@/components/settings/DocumentNumberingSection'
import { GRACE_DAYS } from '@/lib/billing/plans'
import { isValidTimeZone } from '@/lib/utils/timezone'
import { sameValue } from '@/lib/utils/audit-diff'

type SettingsTab = 'account' | 'workspace' | 'branding' | 'defaults' | 'guardian' | 'billing' | 'notifications' | 'integrations' | 'danger'

// FIX (deep audit, section 5 re-pass): backs the Timezone select below.
// Intl.supportedValuesOf is available in every modern browser and in
// Node 18+ (this app's runtime), but wrapped defensively — an older
// embedded webview or a polyfill gap shouldn't be able to break the
// Workspace tab from rendering at all, just fall back to a short list of
// common zones covering this product's actual customer base.
const FALLBACK_TIMEZONES: string[] = [
  'UTC', 'Africa/Nairobi', 'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Cairo',
  'Africa/Accra', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
]

// The full runtime list. Node (server render) and the browser can ship different ICU data, so this
// is only read AFTER mount (see WorkspaceTab) — the first render, on the server and in the browser,
// uses FALLBACK_TIMEZONES, which keeps hydration identical.
function runtimeTimezones(): string[] {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      const list = Intl.supportedValuesOf('timeZone')
      // The runtime list omits 'UTC' (it only holds canonical zone names).
      return list.includes('UTC') ? list : ['UTC', ...list]
    }
  } catch { /* fall through to static list */ }
  return FALLBACK_TIMEZONES
}

// FIX (deep audit, section 5 re-pass): completes the SOW-language feature.
// `sow_language` already existed as a writable workspace column and was
// even selected (unused) inside app/api/sow/generate/route.ts's own
// query — the data plumbing was there, but no UI ever set it and nothing
// ever read it back out to affect generation. See lib/ai/sow-content.ts
// for the generation side and app/api/sow/generate/route.ts for where
// this is now actually threaded through. Scoped to a curated list rather
// than free text, since each entry needs matching translated boilerplate
// (buildBoilerplateSections) — adding a language means adding both an
// entry here and translations there, not just a string.
const SOW_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'fr', label: 'French (Français)' },
  { code: 'pt', label: 'Portuguese (Português)' },
  { code: 'de', label: 'German (Deutsch)' },
  { code: 'sw', label: 'Swahili (Kiswahili)' },
]

// Maps a stored value (possibly a legacy regional code like 'en-US', or
// something unrecognized entirely) onto one of SOW_LANGUAGES' codes.
// Mirrors the same normalization api/workspace/settings/route.ts applies
// server-side, so the two can't disagree about what a saved value means.
function normalizeSowLanguage(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'en'
  const base = value.replace('_', '-').split('-')[0].toLowerCase()
  return SOW_LANGUAGES.some(l => l.code === base) ? base : 'en'
}

// ── Workspace form <-> server values ─────────────────────────────────────────
// The Workspace and Guardian tabs edit a form, but only fields the person
// actually changed are sent, together with the value each one had when the
// page loaded. The server refuses the save if a colleague changed the same
// field in the meantime instead of silently overwriting it.
const trimText = (v: unknown) => String(v ?? '').trim()

function workspaceToForm(ws: any) {
  return {
    name:         ws?.name || '',
    slug:         ws?.slug || '',
    agencyName:   ws?.agency_name || '',
    industry:     ws?.industry || '',
    timezone:     ws?.timezone || '',
    currency:     ws?.currency || 'USD',
    governingLaw: ws?.governing_law || '',
    sowLanguage:  normalizeSowLanguage(ws?.sow_language),
    taxId:                      ws?.tax_id || '',
    phone:                      ws?.phone || '',
    website:                    ws?.website || '',
    replyToEmail:               ws?.reply_to_email || '',
    defaultPaymentInstructions: ws?.default_payment_instructions || '',
    defaultTaxRate:             String(ws?.default_tax_rate ?? 0),
    defaultTaxInclusive:        ws?.default_tax_inclusive ?? true,
    defaultPaymentTermsDays:    ws?.default_payment_terms_days != null ? String(ws.default_payment_terms_days) : '',
    autoClientReminders:        ws?.auto_client_reminders ?? false,
    clientReminderAfterDays:    String(ws?.client_reminder_after_days ?? 3),
    clientReminderMax:          String(ws?.client_reminder_max ?? 3),
    legalAddress: {
      line1:      ws?.legal_address?.line1 || '',
      line2:      ws?.legal_address?.line2 || '',
      city:       ws?.legal_address?.city || '',
      region:     ws?.legal_address?.region || '',
      postalCode: ws?.legal_address?.postalCode || '',
      country:    ws?.legal_address?.country || '',
    },
  }
}

function cleanAddress(a: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ['line1', 'line2', 'city', 'region', 'postalCode', 'country']) {
    const v = trimText(a?.[k])
    if (v) out[k] = v
  }
  return out
}

/** A form value in the shape the server stores it. */
function toServerValue(key: string, value: any): unknown {
  switch (key) {
    case 'autoClientReminders':
    case 'defaultTaxInclusive':
    case 'proactiveRiskAlertsEnabled': return !!value
    case 'defaultTaxRate':             return Math.round(Number(value) * 100) / 100
    case 'defaultPaymentTermsDays':    return trimText(value) === '' ? null : Number(value)
    case 'clientReminderAfterDays':
    case 'clientReminderMax':
    case 'proactiveRiskThreshold':     return Number(value)
    case 'legalAddress':               return cleanAddress(value)
    default:                           return trimText(value)
  }
}

function workspaceSnapshot(ws: any): Record<string, unknown> {
  const snap: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(workspaceToForm(ws))) snap[k] = toServerValue(k, v)
  snap.guardianSensitivityTier    = ws?.guardian_sensitivity_tier || 'medium'
  snap.proactiveRiskAlertsEnabled = ws?.proactive_risk_alerts_enabled ?? true
  snap.proactiveRiskThreshold     = Number(ws?.proactive_risk_threshold ?? 10000)
  return snap
}

const stdLines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
const stdText  = (list: unknown) => (Array.isArray(list) ? list.join('\n') : '')

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
  { key: 'trial_ending',          label: 'Trial ending',            desc: '3, 2 and 1 days before your trial expires' },
  // FIX (build, cron section): co-stall/sow-stall now actually notify —
  // same "wire it server-side, add the toggle" pattern as the three above.
  { key: 'sow_stalled',           label: 'SOW stalled',             desc: "When a client hasn't signed a SOW in 7+ days" },
  { key: 'co_stalled',            label: 'Change order stalled',    desc: "When a client hasn't responded to a change order in 5+ days" },
  // FIX (section-9 audit, 9-G3): SOW signing links expire after 30 days
  // and nothing ever told anyone — see app/api/cron/sow-expiry.
  { key: 'sow_expired',           label: 'SOW link expired',        desc: 'When a SOW signing link expires before the client signs' },
  // FIX (section-10 audit, feature gap — CO expiry): change_orders never
  // had an 'expired' status or a cron to set it (unlike SOW, just above)
  // — see app/api/cron/co-expiry and migration 042.
  { key: 'co_expired',            label: 'Change order link expired', desc: 'When a change order signing link expires before the client responds' },
  // FIX (deep audit, notifications section): approval decisions on your
  // own requests (see 'approval_requested' above, which is the other
  // side of this — for the approver) were fully wired server-side but
  // had no toggle here at all, unlike everything else in this list.
  { key: 'approval_decision',     label: 'Your request approved/rejected', desc: 'When someone approves or rejects a document you sent for approval' },
  // FIX (deep audit, notifications section): invoice sending itself never
  // had a toggle — only the payment/overdue events that follow it did, even
  // though all three are seeded together in workspace_notification_defaults
  // (migration 004). See sendInvoiceSentInternalEmail.
  { key: 'invoice_sent',          label: 'Invoice sent',            desc: 'When a teammate sends an invoice to a client' },
  // FIX (cron audit, section 17 — closing pass): four newly-wired events
  // (milestone overdue, retainer ended, guardian flag stalled, invoice
  // disputed) — added in the same change as their notify/email wiring so
  // none of them repeat the "permanently on, no toggle" bug fixed above.
  { key: 'payment_milestone_overdue', label: 'Payment milestone overdue', desc: 'When a payment milestone passes its due date unpaid' },
  { key: 'retainer_ending',       label: 'Retainer term ended',     desc: "When a retainer's contracted duration runs out and billing stops" },
  { key: 'guardian_flag_stalled', label: 'Scope flag stalled',      desc: "When an open scope flag hasn't been actioned in 5+ days" },
  { key: 'invoice_disputed',      label: 'Invoice disputed',        desc: 'When a client flags a question or concern about an invoice from the portal' },
  { key: 'project_assigned',      label: 'Added to a project',      desc: 'When a teammate adds you to a project' },
  { key: 'invoice_payment_claimed', label: 'Client says they paid',   desc: 'When a client tells you from the invoice portal that they have paid (you still record the payment)' },
]

// FIX (re-audit, notifications section): both of these are fully wired
// server-side (notifyMembersWithPermission / notifyEntityOwner) and were
// permanently on with no toggle — same "wire it, forget the toggle"
// pattern as NOTIF_ITEMS above. They don't belong in that list: neither
// event ever sends an email, so a toggle rendered under "Email
// notifications" for them would do nothing visible. These control
// in_app_enabled via the same PATCH endpoint instead — see
// api/notifications/preferences/route.ts.
const IN_APP_NOTIF_ITEMS = [
  { key: 'flag_comment_added',            label: 'Comments on scope flags', desc: 'When someone comments on a flag or exception you can act on' },
  { key: 'approval_no_reachable_approver', label: 'Approval stuck — no approver', desc: "When a pending approval's assigned role or user can't be reached (requires managing workspace settings)" },
  // FIX (deep audit, notifications section): same "wired server-side,
  // never got a toggle" gap as the two above — see
  // lib/utils/project-messages.ts. No email counterpart exists for
  // mentions, so this belongs here rather than in NOTIF_ITEMS.
  { key: 'project_message_mention',       label: '@-mentions in project discussion', desc: 'When someone @-mentions you in a project message' },
  { key: 'member_joined',                 label: 'Teammate joined',         desc: 'When someone accepts an invitation and joins the workspace (sent to members who can invite people)' },
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — minor):
  // previously silently controlled by the 'member_joined' toggle above,
  // with no way to mute one without the other. Split out.
  { key: 'member_left',                   label: 'Teammate left',           desc: 'When a member leaves the workspace on their own' },
  // FIX (fix round, Projects & Dashboard section 7): same overlap bug as
  // member_left above — this was silently controlled by the
  // 'project_assigned' ("Added to a project") toggle, with no way to mute
  // one without the other. Split out; no email counterpart, so it belongs
  // here rather than in NOTIF_ITEMS.
  { key: 'project_removed',               label: 'Removed from a project',  desc: 'When a teammate removes you from a project' },
  { key: 'client_viewed',                 label: 'Client opened a document', desc: 'The first time a client opens a SOW, change order or invoice you sent' },
]

interface Props {
  workspace:   any
  billing:     any
  defaults:    any
  logoUrl:     string | null
  session:     SessionUser
  permissions: { manageWorkspace: boolean; manageBilling: boolean; viewAuditLog: boolean; manageRoles: boolean }
  mfaMandatory: boolean
}

export default function SettingsClient({ workspace, billing, defaults, logoUrl, session, permissions, mfaMandatory }: Props) {
  const searchParams = useSearchParams()
  const router       = useRouter()
  const supabase     = createClient()
  // FIX (deep audit, Settings section): the ?tab= value was cast straight
  // to SettingsTab with no validation, so a stale or mistyped value
  // (?tab=general, a bookmark from before a tab was renamed) selected
  // nothing in the nav AND rendered a completely blank content pane —
  // every `tab === '...'` branch below simply failed to match. Validate
  // against the real tab list and fall back to 'account'. The Team page
  // already does this correctly for its own ?tab= handling.
  const requestedTab = searchParams.get('tab')
  const [tab, setTabState] = useState<SettingsTab>(
    TABS.some(t => t.key === requestedTab) ? (requestedTab as SettingsTab) : 'account'
  )

  // Keep the URL in step with the selected tab, so a tab is linkable and
  // survives a refresh — the ?tab= parameter was read on mount but never
  // written, which made it a one-way deep link that silently reset to
  // Account the moment the page reloaded.
  function setTab(next: SettingsTab) {
    setTabState(next)
    setError(''); setConflict(false); setSaved('')
    const params = new URLSearchParams(Array.from(searchParams.entries()))
    params.set('tab', next)
    router.replace(`/settings?${params.toString()}`, { scroll: false })
  }
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState('')
  const [error,  setError]  = useState('')
  const [conflict, setConflict] = useState(false)

  const [wsForm, setWsForm] = useState(() => workspaceToForm(workspace))

  // What each saved field looked like when this page loaded (updated after our
  // own successful saves) — sent alongside changes so a concurrent edit by a
  // colleague is detected instead of overwritten.
  const baseRef = useRef<Record<string, unknown>>(workspaceSnapshot(workspace))
  const lastPatchJson = useRef<any>(null)

  const patchWorkspace = async (url: string, body: Record<string, any>) => {
    const changes: Record<string, unknown> = {}
    const expected: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(body)) {
      const value = toServerValue(key, raw)
      if (sameValue(value, baseRef.current[key])) continue
      changes[key] = value
      expected[key] = baseRef.current[key]
    }
    if (Object.keys(changes).length === 0) {
      setError(''); setConflict(false)
      setSaved('Nothing to save — no changes were made.'); setTimeout(() => setSaved(''), 2000)
      return true
    }
    const ok = await patch(url, { ...changes, expected })
    if (ok) {
      // Re-baseline on what the SERVER stored (it trims, collapses whitespace, caps length…), not on
      // what was typed — otherwise the next edit of the same field sends a stale `expected` and
      // gets a false "changed by someone else" conflict until the page is reloaded.
      const stored = lastPatchJson.current?.values
      baseRef.current = { ...baseRef.current, ...changes, ...(stored && typeof stored === 'object' ? stored : {}) }
    }
    return ok
  }
  const [brandColour, setBrandColour] = useState(() => workspace?.brand_colour || '#1A5C3A')
  const [logoPreview, setLogoPreview] = useState<string | null>(logoUrl)

  const [defaultsForm, setDefaultsForm] = useState(() => ({
    revRounds:      String(defaults?.revision_rounds ?? 2),
    payStructure:   defaults?.payment_structure || '50_50',
    revisionPolicy: defaults?.revision_policy || '',
    paymentTerms:   defaults?.payment_terms || '',
    outOfScope:     stdText(defaults?.out_of_scope_clauses),
    assumptions:    stdText(defaults?.assumptions),
  }))

  const [guardianForm, setGuardianForm] = useState(() => ({
    sensitivity:   workspace?.guardian_sensitivity_tier || 'medium',
    riskEnabled:   workspace?.proactive_risk_alerts_enabled ?? true,
    // FIX (deep audit, section 5 re-pass): `|| 10000` treated a validly-
    // saved 0 ("alert on any project without a signed SOW, regardless of
    // value") the same way the Save handler below used to before it was
    // fixed — as falsy, silently substituting the default. The save path
    // already correctly distinguishes "genuinely unset" from "explicitly
    // zero" (see the onClick handler's own comment further down); this
    // read path didn't, so a workspace that successfully saved 0 saw
    // "10000" on next page load, and saving again from that stale value
    // would have overwritten the real 0 right back to 10000.
    riskThreshold: String(workspace?.proactive_risk_threshold ?? 10000),
  }))


  async function patch(path: string, body: any) {
    setSaving(true); setError(''); setConflict(false)
    lastPatchJson.current = null
    try {
      const res  = await fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json().catch(() => ({}))
      lastPatchJson.current = json
      if (!res.ok) {
        if (Array.isArray(json.conflicts)) setConflict(true)
        throw new Error(json.error || 'Save failed')
      }
      setSaved('Changes saved.'); setTimeout(() => setSaved(''), 2000)
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
          {/* FIX (deep audit, section 5 re-pass): `permissions.manageRoles`
              was computed on the server and passed all the way down to
              this component and never actually used — no shortcut existed
              anywhere in Settings to the Roles editor, despite Team →
              Roles being exactly the kind of "workspace configuration"
              link that belongs alongside Audit log / Approval workflows
              here. */}
          {permissions.manageRoles && (
            <Link href="/team?tab=roles" className="settings-nav-item">Manage roles</Link>
          )}
        </div>
      </div>
      <div>
        {error && (
          <div className="auth-error" style={{ marginBottom: 14 }}>
            {error}
            {conflict && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>
                  Reload latest settings
                </button>
              </div>
            )}
          </div>
        )}
        {saved && <div className="auth-success" style={{ marginBottom: 14 }}>{saved}</div>}

        {tab === 'account' && <AccountTab session={session} supabase={supabase} router={router} mfaMandatory={mfaMandatory} />}

        {tab === 'workspace' && (
          <WorkspaceTab form={wsForm} setForm={setWsForm} permissions={permissions} onSave={patchWorkspace} saving={saving}
            slugChangedAt={workspace?.slug_changed_at || null} />
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
          <GuardianTab form={guardianForm} setForm={setGuardianForm} permissions={permissions} onSave={patchWorkspace} saving={saving} currency={workspace?.currency || 'USD'} />
        )}

        {tab === 'billing' && <BillingTab workspace={workspace} billing={billing} session={session} permissions={permissions} />}

        {tab === 'notifications' && <NotificationsTab permissions={permissions} />}

        {tab === 'integrations' && <IntegrationsTab session={session} />}

        {tab === 'danger' && <DangerTab workspace={workspace} permissions={permissions} session={session} />}
      </div>
    </div>
  )
}

// ── ACCOUNT ──────────────────────────────────────────────────
function AccountTab({ session, supabase, router, mfaMandatory }: any) {
  const [name,        setName]        = useState(session.name)
  const [currentPw,   setCurrentPw]   = useState('')
  const [newPw,       setNewPw]       = useState('')
  const [confirmPw,   setConfirmPw]   = useState('')
  const [pwLoading,   setPwLoading]   = useState(false)
  const [nameLoading, setNameLoading] = useState(false)
  const [msg,         setMsg]         = useState('')
  const [err,         setErr]         = useState('')
  // FEATURE (cron audit, section 17 — feature gap): see
  // app/api/account/delete/route.ts's own header comment for the full
  // story on why this needed building.
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteErr,     setDeleteErr]     = useState('')
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
  // gap): avatar_url has been readable and rendered elsewhere (Team,
  // project members, discussion) for as long as those features have
  // existed, but there was never anywhere in the app to actually set it —
  // see api/workspace/profile/avatar/route.ts's own comment for the full
  // story. This is that control.
  const [avatarUrl,     setAvatarUrl]     = useState<string | null>(session.avatarUrl)
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarErr,     setAvatarErr]     = useState('')

  async function uploadAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    setAvatarLoading(true); setAvatarErr('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/workspace/profile/avatar', { method: 'POST', body: formData })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setAvatarErr(json.error || 'Failed to upload photo'); return }
      setAvatarUrl(json.avatarUrl)
      router.refresh()
    } catch { setAvatarErr('Failed to upload photo') } finally { setAvatarLoading(false) }
  }

  async function removeAvatar() {
    setAvatarLoading(true); setAvatarErr('')
    try {
      const res = await fetch('/api/workspace/profile/avatar', { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setAvatarErr(json.error || 'Failed to remove photo'); return }
      setAvatarUrl(null)
      router.refresh()
    } catch { setAvatarErr('Failed to remove photo') } finally { setAvatarLoading(false) }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault()
    setNameLoading(true); setMsg(''); setErr('')
    try {
      // Name is written server-side only (sanitised, and mirrored to the auth
      // profile there) — the browser no longer calls supabase.auth.updateUser().
      const res = await fetch('/api/workspace/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      // FIX (deep audit, Settings re-pass): a non-OK response fell through
      // this `if` doing nothing — no success message, no error message.
      // The Supabase auth-side name update could have already succeeded
      // while the app's own profile record silently failed to sync, and
      // the person had no way to know anything had gone wrong.
      if (res.ok) { setMsg('Name updated.'); router.refresh() }
      else {
        const json = await res.json().catch(() => ({}))
        setErr(json.error || 'Failed to update name')
      }
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
      //
      // FIX (deep audit, Auth+MFA re-pass — password confirmation): now
      // also sends currentPassword — required and verified server-side
      // for any account with a real password (session.hasPasswordIdentity
      // decides whether the field even renders below).
      const res = await fetch('/api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPw, currentPassword: currentPw }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Failed to update password')
      setMsg('Password updated.')
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      await supabase.auth.signOut()
      router.push('/login?message=Password+updated.+Please+sign+in+again.')
    } catch (e: any) { setErr(e.message) } finally { setPwLoading(false) }
  }

  // FEATURE (cron audit, section 17 — feature gap): see
  // app/api/account/delete/route.ts's own header comment for the full
  // story on why this needed building.
  async function handleDeleteAccount() {
    if (deleteConfirm.trim().toLowerCase() !== session.email.toLowerCase()) return
    setDeleteLoading(true); setDeleteErr('')
    try {
      const res  = await fetchWithStepUp('/api/account/delete', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmEmail: deleteConfirm.trim() }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setDeleteErr(json.error || 'Could not delete account'); return }
      await supabase.auth.signOut()
      router.push('/login?message=Account+deleted.')
    } catch (e: unknown) {
      setDeleteErr(e instanceof Error ? e.message : 'Could not delete account')
    } finally { setDeleteLoading(false) }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Account settings</h2>
      {msg && <div className="auth-success" style={{ marginBottom: 14 }}>{msg}</div>}
      {err && <div className="auth-error"  style={{ marginBottom: 14 }}>{err}</div>}
      <div className="settings-section">
        <div className="settings-section-title">Profile</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
          {avatarUrl ? (
            <img src={avatarUrl} alt="" width={56} height={56}
              style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
          ) : (
            <div style={{
              width: 56, height: 56, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: avatarColour(session.name), color: '#fff',
              fontSize: 18, fontWeight: 600,
            }}>
              {initials(session.name)}
            </div>
          )}
          <div>
            <div style={{ display: 'flex', gap: 8 }}>
              <label className="btn btn-secondary btn-sm" style={{ cursor: avatarLoading ? 'default' : 'pointer' }}>
                {avatarLoading ? <span className="spin" /> : (avatarUrl ? 'Change photo' : 'Upload photo')}
                <input type="file" accept="image/png,image/jpeg" onChange={uploadAvatar}
                  disabled={avatarLoading} style={{ display: 'none' }} />
              </label>
              {avatarUrl && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={avatarLoading} onClick={removeAvatar}>
                  Remove
                </button>
              )}
            </div>
            <p className="fhint" style={{ marginTop: 6 }}>PNG or JPG, up to 2MB.</p>
            {avatarErr && <p className="ferr">{avatarErr}</p>}
          </div>
        </div>
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
          {/* FIX (deep audit, Auth+MFA re-pass — password confirmation):
              an OAuth-only account (session.hasPasswordIdentity false) has
              no existing password to confirm — this is setting one for the
              first time, not changing it, so the field doesn't apply. */}
          {session.hasPasswordIdentity && (
            <div className="fgrp">
              <label className="flbl">Current password</label>
              <input type="password" className="finp" value={currentPw}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCurrentPw(e.target.value)}
                placeholder="Current password" autoComplete="current-password" />
            </div>
          )}
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
            disabled={pwLoading || !newPw || !confirmPw || newPw !== confirmPw || (session.hasPasswordIdentity && !currentPw)}>
            {pwLoading ? <span className="spin" /> : 'Update password'}
          </button>
        </form>
      </div>
      <ChangeEmailSection currentEmail={session.email} />
      <SessionsSection />
      {/* FIX (deep audit, Auth+MFA re-pass): was permissionsRequireMfa(
          session.permissions) — checks only the ACTIVE workspace's
          permissions, the same narrow check userHasAnyMfaMandatoryMembership
          (lib/auth/session.ts) was written to replace at mfa-setup's badge,
          DELETE /api/auth/mfa/factors' guard, and change-password's aal2
          gate. This was the fifth call site that fix missed: a member whose
          mandatory-MFA role lives in a non-active workspace saw an enabled
          "Disable two-factor" button that the server (correctly, via
          userHasAnyMfaMandatoryMembership) would still 403 — and never saw
          the "Required, not set up" badge. Now computed server-side in
          app/(app)/settings/page.tsx via the same shared function every
          other site uses, and passed down as a prop. */}
      <MfaSection mandatory={mfaMandatory} />
      {/* FEATURE (cron audit, section 17 — feature gap): personal account
          deletion, not workspace deletion — deliberately NOT gated behind
          permissions.manageWorkspace (unlike DangerTab below), since any
          authenticated member can delete their own account regardless of
          what role they hold. See app/api/account/delete/route.ts's own
          header comment for the full design (soft delete, reuses the
          same per-workspace leave guards as the workspace switcher's
          existing "Leave" action, 30-day grace period before the
          anonymization cron scrubs the record). */}
      <div className="settings-section" style={{ border: '1px solid #FECACA', marginTop: 24 }}>
        <div className="settings-section-title" style={{ color: 'var(--red)' }}>Delete account</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 16 }}>
          Permanently delete your ScopeGov account. This leaves every workspace you belong to
          and cannot be undone once processed.
          {' '}
          <strong>
            You can&apos;t delete your account while you&apos;re the only member — or the only
            admin — of a workspace.
          </strong>
          {' '}
          Transfer ownership, reassign that permission, or delete the workspace first (Settings &gt; Danger zone),
          then retry.
        </p>
        {deleteErr && <div className="auth-error" style={{ marginBottom: 14 }}>{deleteErr}</div>}
        <div className="fgrp">
          <label className="flbl">Type <strong>{session.email}</strong> to confirm</label>
          <input className="finp err" value={deleteConfirm}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeleteConfirm(e.target.value)}
            placeholder={session.email} />
        </div>
        <button className="btn btn-danger btn-sm"
          disabled={deleteConfirm.trim().toLowerCase() !== session.email.toLowerCase() || deleteLoading}
          onClick={handleDeleteAccount}>
          {deleteLoading ? <span className="spin" /> : 'Delete my account'}
        </button>
      </div>
    </div>
  )
}

// ── WORKSPACE ─────────────────────────────────────────────────
function WorkspaceTab({ form, setForm, permissions, onSave, saving, slugChangedAt }: any) {
  // Full runtime timezone list, read after mount (see runtimeTimezones).
  const [zones, setZones] = useState<string[]>(FALLBACK_TIMEZONES)
  useEffect(() => { setZones(runtimeTimezones()) }, [])

  if (!permissions.manageWorkspace) return <Restricted />

  function set<K extends string>(key: K, value: string | boolean) {
    setForm((f: any) => ({ ...f, [key]: value }))
  }

  // FEATURE (deep audit, Settings independent re-pass — feature gap): see
  // workspace/settings/route.ts's own comment on the slug case — this is
  // the front door for the handle that column has always existed for but
  // never had one. Lowercased and hyphen-cleaned as the person types, to
  // match what the server will normalise it to anyway, so what they see
  // here is what actually gets saved instead of surprising them after a
  // reload. The 30-day cooldown mirrors SLUG_MIN_DAYS_BETWEEN_CHANGES —
  // shown here only as an advisory hint; the server is the real gate.
  const SLUG_MIN_DAYS_BETWEEN_CHANGES = 30
  function setSlug(raw: string) {
    const v = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-/, '')
    set('slug', v)
  }
  const nextSlugChangeAt = slugChangedAt
    ? new Date(new Date(slugChangedAt).getTime() + SLUG_MIN_DAYS_BETWEEN_CHANGES * 24 * 60 * 60 * 1000)
    : null
  const slugLocked = !!(nextSlugChangeAt && nextSlugChangeAt.getTime() > Date.now())
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
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Industry</label>
            {/* A fixed list, like onboarding: the server only accepts these values, so a free-text box
                could never save anything but an exact match. */}
            <select className="finp" value={form.industry} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set('industry', e.target.value)}>
              {!form.industry && <option value="">Select an industry…</option>}
              {form.industry && !(INDUSTRIES as readonly string[]).includes(form.industry) && (
                <option value={form.industry}>{form.industry} (not in the list — please re-select)</option>
              )}
              {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div className="fgrp">
            <label className="flbl">Default currency</label>
            <select className="finp" value={form.currency} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set('currency', e.target.value)}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Timezone</label>
            <select className="finp" value={form.timezone} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set('timezone', e.target.value)}>
              <option value="">Not set (UTC)</option>
              {/* A saved zone that this browser's list doesn't name (an alias
                  such as Asia/Kolkata, or free text from before this was a
                  select) still shows as its own option. */}
              {form.timezone && !zones.includes(form.timezone) && (
                <option value={form.timezone}>
                  {form.timezone.replace(/_/g, ' ')}{isValidTimeZone(form.timezone) ? '' : ' (unrecognized — please re-select)'}
                </option>
              )}
              {zones.map((tz: string) => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
            </select>
            <span className="fhint">The audit log and your audit, portfolio and report PDFs show times in this timezone. CSV and JSON exports always use UTC.</span>
          </div>
          <div className="fgrp">
            <label className="flbl">Governing law</label>
            <input className="finp" value={form.governingLaw} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('governingLaw', e.target.value)}
              placeholder="e.g. Republic of Kenya" />
            <span className="fhint">Used in the governing-law clause on every SOW you send.</span>
          </div>
        </div>
        <div className="fgrp">
          <label className="flbl">SOW language</label>
          <select className="finp" style={{ maxWidth: 280 }} value={form.sowLanguage}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set('sowLanguage', e.target.value)}>
            {SOW_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
          <span className="fhint">The language every new SOW is drafted in — the client-facing content, and the standard clauses (parties, governing law, signature block).</span>
        </div>
        <div className="fgrp">
          <label className="flbl">Workspace handle <span className="fhint">— used in exported report filenames</span></label>
          <input className="finp" style={{ maxWidth: 280 }} value={form.slug} disabled={slugLocked}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSlug(e.target.value)}
            placeholder="acme-studio" />
          <span className="fhint">
            {slugLocked
              ? `Can be changed again on ${nextSlugChangeAt!.toLocaleDateString()}. Lowercase letters, numbers, and hyphens only.`
              : 'Lowercase letters, numbers, and hyphens only. Changing it can be done again after 30 days, and takes effect on the next report you export.'}
          </span>
        </div>
        <div className="settings-section-title" style={{ marginTop: 24 }}>
          Client reminders <span className="fhint" style={{ fontWeight: 400 }}>— nudge clients automatically</span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-key">Send automatic reminders</div>
            <div className="settings-row-desc">
              Emails your client about an unsigned SOW, an unanswered change order or an overdue invoice, so you
              don&apos;t have to remember to chase. Off by default; the manual Remind buttons keep working either way.
            </div>
          </div>
          <button type="button" className={`toggle ${form.autoClientReminders ? 'on' : 'off'}`}
            onClick={() => set('autoClientReminders', !form.autoClientReminders)} />
        </div>
        {form.autoClientReminders && (
          <div className="f2" style={{ marginTop: 12 }}>
            <div className="fgrp">
              <label className="flbl">Remind after / every <span className="fhint">— days</span></label>
              <input type="number" className="finp" min={1} max={30} step={1} value={form.clientReminderAfterDays}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('clientReminderAfterDays', e.target.value)} />
            </div>
            <div className="fgrp">
              <label className="flbl">At most <span className="fhint">— reminders per document</span></label>
              <input type="number" className="finp" min={1} max={10} step={1} value={form.clientReminderMax}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('clientReminderMax', e.target.value)} />
            </div>
          </div>
        )}
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
          <label className="flbl">Reply-to email <span className="fhint">— optional; where a client&apos;s reply to a SOW, change order or invoice email is delivered. Leave blank and replies go to the person who sent it.</span></label>
          <input className="finp" type="email" value={form.replyToEmail} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('replyToEmail', e.target.value)} placeholder="billing@youragency.com" />
        </div>
        <div className="fgrp">
          <label className="flbl">Default payment instructions <span className="fhint">— pre-fills new invoices; wire/ACH details, &ldquo;per PO terms&rdquo;, etc.</span></label>
          <textarea className="finp" rows={3} value={form.defaultPaymentInstructions}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set('defaultPaymentInstructions', e.target.value)} />
        </div>
        <div className="settings-section-title" style={{ marginTop: 24 }}>
          Billing defaults <span className="fhint" style={{ fontWeight: 400 }}>— pre-fill new invoices and change orders; editable on each one</span>
        </div>
        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Default tax rate (%)</label>
            <input className="finp" type="number" min={0} max={100} step="0.01" value={form.defaultTaxRate}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('defaultTaxRate', e.target.value)} />
            <span className="fhint">e.g. 16 for Kenyan VAT. Leave at 0 if you don&apos;t charge tax.</span>
          </div>
          <div className="fgrp">
            <label className="flbl">Amounts entered are</label>
            <select className="finp" value={form.defaultTaxInclusive ? 'inclusive' : 'exclusive'}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set('defaultTaxInclusive', e.target.value === 'inclusive')}>
              <option value="inclusive">Tax-inclusive (the amount is what the client pays)</option>
              <option value="exclusive">Before tax (tax is added on top)</option>
            </select>
          </div>
        </div>
        <div className="fgrp">
          <label className="flbl">Default payment terms (days) <span className="fhint">— optional; sets each new invoice&apos;s due date this many days out</span></label>
          <input className="finp" type="number" min={0} max={365} step={1} style={{ maxWidth: 160 }} value={form.defaultPaymentTermsDays}
            placeholder="e.g. 14" onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('defaultPaymentTermsDays', e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => onSave('/api/workspace/settings', form)}>
          {saving ? <span className="spin" /> : 'Save changes'}
        </button>
        <DocumentNumberingSection />
      </div>
    </div>
  )
}

// ── BRANDING ──────────────────────────────────────────────────
function BrandingTab({ workspaceId, colour, setColour, preview, setPreview, savedSignature, permissions, onSave, saving }: any) {
  const [logoFile,  setLogoFile]  = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [fileError, setFileError] = useState('')
  const [removingLogo, setRemovingLogo] = useState(false)
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
    if (!/^#[0-9a-fA-F]{6}$/.test(colour)) { setFileError('Brand colour must be a hex colour, e.g. #1A5C3A'); return }
    setFileError('')
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
          // FIX (deep audit, Settings section): this fell through to the
          // branding PATCH below with no early return, so a failed logo
          // upload still produced a successful colour save — and `onSave`
          // sets the shared `saved` flag, so the person got a green
          // "Changes saved." banner sitting directly above a red "Could
          // not upload logo" error. Stop here instead; the colour can be
          // saved on its own by retrying without picking a file.
          const json = await res.json().catch(() => ({}))
          setFileError(json.error || 'Could not upload logo — try again.')
          return
        }
      }
      const ok = await onSave('/api/workspace/branding', { brandColour: colour, ...(logoStoragePath ? { logoStoragePath } : {}) })
      if (ok) setLogoFile(null)
    } finally { setUploading(false) }
  }

  // FIX (deep audit, section 5 — feature gap): there was previously no way
  // to remove a logo once uploaded — see
  // app/api/workspace/branding/logo/route.ts's DELETE handler for the
  // backend half of this. Clears the local preview immediately; the
  // server call is what actually deletes the Storage object and the
  // workspace's logo_storage_path.
  async function removeLogo() {
    if (!confirm('Remove the workspace logo? This can\u2019t be undone — you\u2019ll need to upload a new one.')) return
    setRemovingLogo(true); setFileError('')
    try {
      const res = await fetch('/api/workspace/branding/logo', { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setFileError(json.error || 'Could not remove logo — try again.'); return }
      setPreview(null)
      setLogoFile(null)
    } catch {
      setFileError('Could not remove logo — try again.')
    } finally { setRemovingLogo(false) }
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
    setSigError(''); setSavingSig(true)
    try {
      const res = await fetch('/api/workspace/branding', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencySignatureData: null }),
      })
      if (res.ok) setSigSaved(null)
      else setSigError('Could not remove the signature — try again.')
    } catch { setSigError('Could not remove the signature — try again.') }
    finally { setSavingSig(false) }
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
            <div style={{ display: 'flex', gap: 8 }}>
              <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                <i className="ti ti-upload" style={{ fontSize: 12 }} /> {logoFile ? 'Change logo' : 'Upload logo'}
                <input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} onChange={handleLogoChange} />
              </label>
              {preview && !logoFile && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                  disabled={removingLogo} onClick={removeLogo}>
                  {removingLogo ? <span className="spin spin-dark" /> : 'Remove logo'}
                </button>
              )}
            </div>
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
              {sigError && <p className="ferr" style={{ marginTop: 6 }}>{sigError}</p>}
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

const DEFAULTS_PROJECT_TYPES = Object.keys(PROJECT_TYPE_LABELS)

type StandardsForm = { revisionPolicy: string; paymentTerms: string; outOfScope: string; assumptions: string }

const STD_TEXT_MAX = 1500
const STD_ITEM_MAX = 500
const STD_ITEMS_MAX = 30

function standardsProblem(std: StandardsForm): string {
  if (std.revisionPolicy.trim().length > STD_TEXT_MAX) return `Revision policy wording must be ${STD_TEXT_MAX} characters or fewer.`
  if (std.paymentTerms.trim().length > STD_TEXT_MAX) return `Payment terms wording must be ${STD_TEXT_MAX} characters or fewer.`
  for (const [label, text] of [['exclusions', std.outOfScope], ['assumptions', std.assumptions]] as const) {
    const items = stdLines(text)
    if (items.length > STD_ITEMS_MAX) return `Standard ${label} can have at most ${STD_ITEMS_MAX} items (one per line).`
    if (items.some(i => i.length > STD_ITEM_MAX)) return `Each standard ${label.slice(0, -1)} must be ${STD_ITEM_MAX} characters or fewer.`
  }
  return ''
}

function StandardsFields({ value, onChange, disabled }: { value: StandardsForm; onChange: (patch: Partial<StandardsForm>) => void; disabled?: boolean }) {
  const oosCount = stdLines(value.outOfScope).length
  const asmCount = stdLines(value.assumptions).length
  return (
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
      <div className="settings-section-title">Standard terms</div>
      <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.6 }}>
        Your agency&apos;s usual wording. Whenever a SOW is generated, these are worked into the matching sections
        and appended if the draft leaves them out. Leave a field blank to add nothing for it.
      </p>
      <div className="fgrp">
        <label className="flbl">Revision policy wording <span className="fhint">— {value.revisionPolicy.trim().length}/{STD_TEXT_MAX}</span></label>
        <textarea className="finp" rows={3} disabled={disabled} value={value.revisionPolicy}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ revisionPolicy: e.target.value })}
          placeholder="e.g. Each round covers consolidated feedback delivered within 5 business days of the deliverable." />
      </div>
      <div className="fgrp">
        <label className="flbl">Payment terms wording <span className="fhint">— {value.paymentTerms.trim().length}/{STD_TEXT_MAX}</span></label>
        <textarea className="finp" rows={3} disabled={disabled} value={value.paymentTerms}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ paymentTerms: e.target.value })}
          placeholder="e.g. Invoices are due within 14 days of issue. Work pauses on any invoice more than 7 days overdue." />
      </div>
      <div className="fgrp">
        <label className="flbl">Standard exclusions <span className="fhint">— one per line · {oosCount}/{STD_ITEMS_MAX}</span></label>
        <textarea className="finp" rows={4} disabled={disabled} value={value.outOfScope}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ outOfScope: e.target.value })}
          placeholder={'Hosting and domain fees\nThird-party licences\nContent writing'} />
      </div>
      <div className="fgrp">
        <label className="flbl">Standard assumptions <span className="fhint">— one per line · {asmCount}/{STD_ITEMS_MAX}</span></label>
        <textarea className="finp" rows={4} disabled={disabled} value={value.assumptions}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ assumptions: e.target.value })}
          placeholder={'Client provides all content and brand assets before kickoff\nOne named point of contact approves each deliverable'} />
      </div>
    </div>
  )
}

const REVISION_ROUND_CHOICES = ['1', '2', '3', '4', '5']

function DefaultsTab({ form, setForm, permissions, onSave, saving, setTab }: any) {
  function set(key: string, value: string) {
    setForm((f: any) => ({ ...f, [key]: value }))
  }

  const [scope, setScope] = useState<string>('global')
  const [typeData, setTypeData] = useState<{ revisionRounds: number; paymentStructure: string; isOverride: boolean } | null>(null)
  const [typeStd, setTypeStd] = useState<StandardsForm>({ revisionPolicy: '', paymentTerms: '', outOfScope: '', assumptions: '' })
  const [typeLoading, setTypeLoading] = useState(false)
  // A failed load must NOT fall through to the hardcoded 2 rounds / 50_50 / blank standards below:
  // saving from that state would write a real override made of placeholders.
  const [typeLoadFailed, setTypeLoadFailed] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [localError, setLocalError] = useState('')
  const isGlobal = scope === 'global'

  const stdFromJson = (json: any): StandardsForm => ({
    revisionPolicy: json?.revisionPolicy || '',
    paymentTerms:   json?.paymentTerms || '',
    outOfScope:     stdText(json?.outOfScopeClauses),
    assumptions:    stdText(json?.assumptions),
  })

  useEffect(() => {
    setLocalError(''); setTypeLoadFailed(false)
    if (isGlobal) { setTypeData(null); return }
    let cancelled = false
    setTypeLoading(true)
    fetch(`/api/workspace/defaults?projectType=${scope}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('load failed')))
      .then(json => { if (!cancelled) { setTypeData(json); setTypeStd(stdFromJson(json)) } })
      .catch(() => { if (!cancelled) { setTypeData(null); setTypeLoadFailed(true) } })
      .finally(() => { if (!cancelled) setTypeLoading(false) })
    return () => { cancelled = true }
  }, [scope, isGlobal, reloadTick])

  if (!permissions.manageWorkspace) return <Restricted />

  const revValue = isGlobal ? form.revRounds : String(typeData?.revisionRounds ?? 2)
  const payValue = isGlobal ? form.payStructure : (typeData?.paymentStructure ?? '50_50')
  const std: StandardsForm = isGlobal
    ? { revisionPolicy: form.revisionPolicy, paymentTerms: form.paymentTerms, outOfScope: form.outOfScope, assumptions: form.assumptions }
    : typeStd
  const revChoices = REVISION_ROUND_CHOICES.includes(revValue)
    ? REVISION_ROUND_CHOICES
    : [...REVISION_ROUND_CHOICES, revValue].sort((a, b) => Number(a) - Number(b))

  function setTypeField(patch: Partial<{ revisionRounds: number; paymentStructure: string }>) {
    setTypeData(d => ({
      revisionRounds: d?.revisionRounds ?? 2, paymentStructure: d?.paymentStructure ?? '50_50',
      isOverride: d?.isOverride ?? false, ...patch,
    }))
  }

  function setStd(patch: Partial<StandardsForm>) {
    if (isGlobal) setForm((f: any) => ({ ...f, ...patch }))
    else setTypeStd(prev => ({ ...prev, ...patch }))
  }

  async function refetchType() {
    const res = await fetch(`/api/workspace/defaults?projectType=${scope}`)
    if (res.ok) { const json = await res.json(); setTypeData(json); setTypeStd(stdFromJson(json)) }
  }

  async function saveCurrent() {
    const problem = standardsProblem(std)
    if (problem) { setLocalError(problem); return }
    setLocalError('')
    const standards = {
      revisionPolicy:    std.revisionPolicy.trim(),
      paymentTerms:      std.paymentTerms.trim(),
      outOfScopeClauses: stdLines(std.outOfScope),
      assumptions:       stdLines(std.assumptions),
    }
    if (isGlobal) {
      await onSave('/api/workspace/defaults', { revisionRounds: parseInt(form.revRounds), paymentStructure: form.payStructure, ...standards })
      return
    }
    const ok = await onSave('/api/workspace/defaults', {
      revisionRounds: typeData?.revisionRounds ?? 2,
      paymentStructure: typeData?.paymentStructure ?? '50_50',
      projectType: scope,
      ...standards,
    })
    if (ok) await refetchType()
  }

  async function removeOverride() {
    if (isGlobal || !typeData?.isOverride) return
    if (!confirm(`Remove the ${PROJECT_TYPE_LABELS[scope]} override? New ${PROJECT_TYPE_LABELS[scope]} projects will go back to using the global default.`)) return
    setTypeLoading(true); setLocalError('')
    try {
      const res = await fetch(`/api/workspace/defaults?projectType=${scope}`, { method: 'DELETE' })
      if (res.ok) await refetchType()
      else { const json = await res.json().catch(() => ({})); setLocalError(json.error || 'Could not remove that override. Try again.') }
    } catch { setLocalError('Could not remove that override. Try again.') }
    finally { setTypeLoading(false) }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>SOW defaults</h2>
      <div className="settings-section">
        <div className="settings-section-title">Default SOW settings</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 18, lineHeight: 1.6 }}>
          These values pre-fill every new Statement of Work. You can override them per project, and per project type below.
        </p>

        <div className="fgrp" style={{ marginBottom: 18, maxWidth: 340 }}>
          <label className="flbl">Applies to</label>
          <select className="finp" value={scope} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setScope(e.target.value)}>
            <option value="global">Global default (all project types)</option>
            {DEFAULTS_PROJECT_TYPES.map(pt => <option key={pt} value={pt}>{PROJECT_TYPE_LABELS[pt]}</option>)}
          </select>
          {!isGlobal && (
            <p className="fhint">
              {typeLoading ? 'Loading…' : typeData?.isOverride
                ? `${PROJECT_TYPE_LABELS[scope]} projects use this override instead of the global default.`
                : `No override yet — ${PROJECT_TYPE_LABELS[scope]} projects currently fall back to the global default. Change a value and save to create one.`}
            </p>
          )}
        </div>

        <div className="f2">
          <div className="fgrp">
            <label className="flbl">Default revision rounds</label>
            <select className="finp" disabled={typeLoading} value={revValue}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => isGlobal ? set('revRounds', e.target.value) : setTypeField({ revisionRounds: parseInt(e.target.value) })}>
              {revChoices.map(n => <option key={n} value={n}>{n} round{n !== '1' ? 's' : ''}</option>)}
            </select>
          </div>
          <div className="fgrp">
            <label className="flbl">Default payment structure</label>
            <select className="finp" disabled={typeLoading} value={payValue}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => isGlobal ? set('payStructure', e.target.value) : setTypeField({ paymentStructure: e.target.value })}>
              <option value="50_50">50% upfront / 50% on delivery</option>
              <option value="100_upfront">100% upfront</option>
              <option value="milestones">Milestone-based</option>
              <option value="monthly">Monthly retainer</option>
              <option value="on_delivery">100% on delivery</option>
            </select>
          </div>
        </div>

        <StandardsFields value={std} onChange={setStd} disabled={typeLoading} />

        <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '16px 0 0', lineHeight: 1.6 }}>
          Governing law is set on the{' '}
          <button type="button" onClick={() => setTab?.('workspace')}
            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--green)', textDecoration: 'underline', cursor: 'pointer' }}>
            Workspace tab
          </button>{' '}and applies to every SOW, regardless of project type.
        </p>
        {localError && <p className="ferr" style={{ marginTop: 10 }}>{localError}</p>}
        {typeLoadFailed && (
          <p className="ferr" style={{ marginTop: 10 }}>
            Couldn&apos;t load this project type&apos;s defaults, so nothing is shown to edit.{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReloadTick(t => t + 1)}>Try again</button>
          </p>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary btn-sm" disabled={saving || typeLoading || typeLoadFailed} onClick={saveCurrent}>
            {saving ? <span className="spin" /> : isGlobal ? 'Save defaults' : `Save ${PROJECT_TYPE_LABELS[scope]} override`}
          </button>
          {!isGlobal && typeData?.isOverride && (
            <button className="btn btn-ghost btn-sm" disabled={saving || typeLoading} onClick={removeOverride}>
              Remove override
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function GuardianTab({ form, setForm, permissions, onSave, saving, currency }: any) {
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
            <label className="flbl">Contract value threshold <span className="fhint">({currency})</span></label>
            <input type="number" className="finp" style={{ maxWidth: 200 }} value={form.riskThreshold}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => set('riskThreshold', e.target.value)} min={0} />
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>Alert when a project over this value has no signed SOW. The value is in your workspace currency ({currency}); projects billed in another currency aren&apos;t compared against it.</p>
          </div>
        )}
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => {
            // FIX (deep audit, section 5 re-pass): `parseFloat(...) || 10000`
            // treated a deliberately-entered 0 — "alert on any project
            // without a signed SOW, regardless of value" — as falsy and
            // silently replaced it with the 10,000 default. The input kept
            // showing "0", so the save looked like it worked when the
            // actually-persisted threshold was 10x what was on screen.
            // Only fall back to the default when the field is genuinely
            // unparseable (blank/garbage), not when it parses to a valid 0.
            const parsed = parseFloat(form.riskThreshold)
            const threshold = Number.isFinite(parsed) && parsed >= 0 ? parsed : 10000
            onSave('/api/workspace/settings', {
              guardianSensitivityTier: form.sensitivity,
              proactiveRiskAlertsEnabled: form.riskEnabled,
              proactiveRiskThreshold: threshold,
            })
          }}>
          {saving ? <span className="spin" /> : 'Save settings'}
        </button>
      </div>
    </div>
  )
}

// ── BILLING ───────────────────────────────────────────────────
// Labels for the event types api/billing/history/route.ts returns — kept
// as a small local map rather than reusing lib/pdf/audit-report.tsx's
// humanizeEvent (server-only, part of the PDF renderer bundle) since this
// list only ever needs to cover the handful of billing-specific events.
const BILLING_HISTORY_LABELS: Record<string, string> = {
  'billing.payment_succeeded':          'Payment succeeded',
  'billing.payment_failed_grace_started': 'Payment failed',
  'billing.downgraded_for_nonpayment':  'Downgraded — payment not resolved',
  'billing.subscription_ended':         'Subscription ended',
  'billing.trial_expired':              'Trial ended',
  'billing.plan_changed':               'Plan changed',
  'billing.payment_retry_failed':       'Payment retry failed',
  'billing.refund_processed':           'Refund processed',
  'billing.charge_dispute_create':      'Payment disputed',
  'billing.charge_dispute_resolve':     'Dispute resolved',
}

// FIX (Billing re-pass #3): every cancel, resume, switch and end-of-period
// event is stored as the same 'billing.plan_changed' type and the tab printed
// "Plan changed" for all of them (the API returned `action` and the UI threw
// it away). Describe what actually happened.
const PLAN_ACTION_LABELS: Record<string, string> = {
  cancellation_requested:      'Cancellation requested',
  cancellation_reversed:       'Cancellation reversed',
  subscription_not_renewing:   'Subscription set to end',
  subscription_disabled:       'Subscription disabled',
  subscription_created:        'Subscription started',
}

function billingHistoryLabel(h: any): string {
  if (h.eventType === 'billing.plan_changed') {
    const base = (h.action && PLAN_ACTION_LABELS[h.action]) || 'Plan changed'
    if (h.from && h.to && h.from !== h.to) return `${base}: ${PLAN_LABELS[h.from] || h.from} → ${PLAN_LABELS[h.to] || h.to}`
    if (h.to && h.action === 'subscription_created') return `${base}: ${PLAN_LABELS[h.to] || h.to}${h.interval ? ` (${h.interval})` : ''}`
    return base
  }
  return BILLING_HISTORY_LABELS[h.eventType] || h.eventType
}

// Loads Paystack's inline checkout only when someone actually starts a
// payment. It used to be a beforeInteractive <Script> in the root layout, so
// every page — including the public client-facing SOW/CO/invoice portals —
// blocked first paint on a third-party script and sent the visitor's browser
// to js.paystack.co.
function loadPaystackScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if ((window as any).PaystackPop) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-paystack-inline]') as HTMLScriptElement | null
    const el = existing || document.createElement('script')
    const done = () => (window as any).PaystackPop ? resolve() : reject(new Error('Paystack did not initialise'))
    el.addEventListener('load', done, { once: true })
    el.addEventListener('error', () => reject(new Error('Could not load the payment provider')), { once: true })
    if (!existing) {
      el.src = 'https://js.paystack.co/v1/inline.js'
      el.async = true
      el.setAttribute('data-paystack-inline', '1')
      document.head.appendChild(el)
    }
  })
}

function BillingTab({ workspace, billing, session, permissions }: any) {
  const planTier  = workspace?.plan_tier || 'trial'
  const planLabel = PLAN_LABELS[planTier] || planTier
  const daysLeft  = workspace?.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(workspace.trial_ends_at).getTime() - Date.now()) / 86400000))
    : null

  // FIX (deep audit, Billing re-pass — feature gap): this always defaulted
  // to 'monthly' regardless of which interval the workspace is actually
  // on (billing.plan_interval — see migration 045, populated by the
  // webhook). That's what made switching intervals impossible in
  // practice: even once the button below exists, the toggle needs to
  // start on the customer's REAL current interval, or "switch to annual"
  // and "you're already on annual" look identical.
  const [planInterval, setPlanInterval] = useState<'monthly' | 'annual'>(billing?.plan_interval || 'monthly')
  const [upgrading,    setUpgrading]    = useState<string | null>(null)
  const [cancelling,   setCancelling]   = useState(false)
  const [cancelError,  setCancelError]  = useState('')
  const [justCancelled, setJustCancelled] = useState(false)
  // FEATURE (build, Billing re-pass): resuming a not-yet-lapsed
  // cancellation — see api/billing/resume's own comment for why this
  // never existed until now.
  const [resuming,     setResuming]     = useState(false)
  const [resumeError,  setResumeError]  = useState('')

  // FEATURE (deep audit, Reports & Audit / Billing re-pass — feature gap):
  // there was no way at all to see past charges/receipts in-app — see
  // api/billing/history/route.ts's own header comment for the full story.
  const [history,        setHistory]        = useState<any[] | null>(null)
  const [historyError,   setHistoryError]   = useState('')
  const [historyMore,    setHistoryMore]    = useState<{ hasMore: boolean; nextOffset: number }>({ hasMore: false, nextOffset: 0 })
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  // After Paystack's popup reports success the plan only changes once the
  // webhook lands; this tracks that wait (see confirmPayment below).
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    // Members without MANAGE_BILLING render <Restricted /> below and used to
    // fire this request anyway, collecting a pointless 403.
    if (!permissions.manageBilling) return
    let cancelled = false
    fetch('/api/billing/history')
      .then(async res => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) { setHistoryError(json.error || 'Could not load billing history.'); return }
        setHistory(json.rows || [])
        setHistoryMore({ hasMore: !!json.hasMore, nextOffset: json.nextOffset || 0 })
      })
      .catch(() => { if (!cancelled) setHistoryError('Could not load billing history.') })
    return () => { cancelled = true }
  }, [permissions.manageBilling])

  async function loadMoreHistory() {
    setHistoryLoadingMore(true)
    try {
      const res = await fetch(`/api/billing/history?offset=${historyMore.nextOffset}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error)
      setHistory(prev => [...(prev || []), ...(json.rows || [])])
      setHistoryMore({ hasMore: !!json.hasMore, nextOffset: json.nextOffset || 0 })
    } catch { setHistoryError('Could not load more billing history.') }
    finally { setHistoryLoadingMore(false) }
  }

  if (!permissions.manageBilling) return <Restricted need="MANAGE_BILLING" />

  async function handleCancel() {
    if (!confirm('Cancel your subscription? You\u2019ll keep access until the end of the current billing period, then the workspace will be downgraded.')) return
    setCancelling(true); setCancelError('')
    try {
      const res  = await fetchWithStepUp('/api/billing/cancel', { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (res.ok) { setJustCancelled(true); window.location.reload() }
      else setCancelError(json.error || 'Could not cancel — try again or contact support.')
    } finally { setCancelling(false) }
  }

  async function handleResume() {
    setResuming(true); setResumeError('')
    try {
      const res  = await fetch('/api/billing/resume', { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (res.ok) window.location.reload()
      else setResumeError(json.error || 'Could not resume — try again or contact support.')
    } finally { setResuming(false) }
  }

  // The webhook, not the popup, changes the plan (BUG-054), so after a
  // successful payment poll until the workspace actually reflects it instead
  // of reloading into the old plan behind an alert.
  async function confirmPayment(before: { planTier: string | null; planInterval: string | null }) {
    setConfirming(true)
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000))
      try {
        const res = await fetch('/api/billing/status')
        if (res.ok) {
          const st = await res.json()
          if (st.planTier !== before.planTier || st.planInterval !== before.planInterval) break
        }
      } catch { /* keep polling */ }
    }
    window.location.reload()
  }

  async function handleUpgrade(planKey: string, intervalOverride?: 'monthly' | 'annual') {
    const targetInterval = intervalOverride || planInterval
    // Paystack does not prorate: switching starts a NEW subscription that is
    // charged immediately and the old one ends now, so any time already paid
    // for on it is forfeited. Say so before money moves.
    const hasPaidSubscription = !!billing?.paystack_subscription_code && !billing?.cancels_at_period_end && planTier !== 'trial'
    if (hasPaidSubscription && billing?.current_period_end && new Date(billing.current_period_end) > new Date()) {
      const ok = confirm(
        `Switching plans starts a new subscription and charges you now. Your current subscription ends immediately, and the time you've already paid for on it (until ${formatDate(billing.current_period_end)}) is not credited or refunded.\n\nContinue?`
      )
      if (!ok) return
    }
    setUpgrading(planKey)
    try {
      await loadPaystackScript().catch(() => {
        throw new Error('Could not load the payment provider. If you\u2019re using an ad-blocker or privacy extension, try disabling it for this site, then refresh and try again.')
      })
      // FIX (re-audit, Billing section): plain fetch(), so the new
      // requireStepUpForCurrentUser() guard on /api/billing/upgrade would
      // have surfaced as an opaque "Could not start checkout" error for
      // anyone without a fresh-enough session, with no way to actually get
      // past it. fetchWithStepUp is the same wrapper billing/cancel already
      // uses just above — it shows the "Confirm it's you" modal and retries
      // this exact request once confirmed.
      const res  = await fetchWithStepUp('/api/billing/upgrade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planKey, interval: targetInterval }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not start checkout')
      const before = { planTier: planTier as string | null, planInterval: (billing?.plan_interval ?? null) as string | null }
      const handler = (window as any).PaystackPop.setup({
        key:      json.publicKey,
        email:    json.email,
        plan:     json.planCode,
        currency: 'USD',
        metadata: json.metadata,
        callback: () => { void confirmPayment(before) },
        onClose: () => {},
      })
      handler.openIframe()
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

  // FIX (deep audit, Billing re-pass — feature gap): grace_period_started_at
  // is set by the webhook on invoice.payment_failed and enforced 5 days
  // later by cron/payment-overdue, but until now it was never surfaced
  // anywhere in the app — the only signal a customer got was one email at
  // the moment the charge failed. cancels_at_period_end gets a persistent
  // banner right below; this state deserves the same treatment, since
  // missing/ignoring that one email currently means no warning at all
  // before a forced downgrade to Solo.
  const graceDaysLeft = billing?.grace_period_started_at
    ? Math.max(0, GRACE_DAYS - Math.floor((Date.now() - new Date(billing.grace_period_started_at).getTime()) / 86400000))
    : null

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Billing & plan</h2>

      {confirming && (
        <div className="banner banner-warn" style={{ marginBottom: 14, alignItems: 'center' }}>
          <span className="spin spin-dark" style={{ marginRight: 10 }} />
          <span>Payment received — confirming your plan. This page will refresh as soon as it&apos;s active.</span>
        </div>
      )}

      {graceDaysLeft !== null && (
        <div className="banner banner-warn" style={{ marginBottom: 14, alignItems: 'center', justifyContent: 'space-between' }}>
          <span>
            Your last payment failed. Update your payment method within {graceDaysLeft} day{graceDaysLeft === 1 ? '' : 's'} or this
            workspace will be downgraded to Solo.
          </span>
          <button
            className="btn btn-primary btn-sm"
            disabled={!!upgrading}
            onClick={() => handleUpgrade(planTier === 'trial' ? 'solo' : planTier, billing?.plan_interval || 'monthly')}>
            Retry with a new card
          </button>
        </div>
      )}

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
            {/* FEATURE (deep audit, Billing re-pass): payment_method_last4/
                type existed as columns, were fetched by settings/page.tsx,
                and were never once rendered anywhere — a fully scaffolded
                "card on file" feature with no display. Now populated by
                the webhook (see extractPaymentMethod) and shown here. */}
            {billing?.payment_method_last4 && (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {billing.payment_method_type ? `${billing.payment_method_type} ` : ''}···· {billing.payment_method_last4}
              </div>
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
          <div className="banner banner-warn" style={{ marginTop: 12, alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Subscription cancelled — access until {formatDate(billing.current_period_end)}</span>
            <button className="btn btn-primary btn-sm" disabled={resuming} onClick={handleResume}>
              {resuming ? <span className="spin" /> : 'Resume subscription'}
            </button>
          </div>
        )}
        {resumeError && (
          <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{resumeError}</p>
        )}
        {cancelError && (
          <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{cancelError}</p>
        )}
      </div>

      {/* FEATURE (deep audit, Reports & Audit / Billing re-pass — feature
          gap): payment history — see api/billing/history/route.ts's own
          header comment for why this never existed until now. */}
      <div className="settings-section" style={{ marginBottom: 14 }}>
        <div className="settings-section-title">Payment history</div>
        {historyError ? (
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>{historyError}</p>
        ) : history === null ? (
          <div style={{ display: 'flex', padding: '12px 0' }}><span className="spin spin-dark" /></div>
        ) : history.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No billing events yet.</p>
        ) : (
          <table className="gov-table" style={{ width: '100%' }}>
            <thead><tr><th>Event</th><th>Date</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id}>
                  <td style={{ fontSize: 13 }}>
                    {billingHistoryLabel(h)}
                    {h.reference && <div style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'IBM Plex Mono, monospace' }}>Ref {h.reference}</div>}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{formatDate(h.createdAt)}</td>
                  <td className="td-mono" style={{ textAlign: 'right', fontSize: 12 }}>
                    {h.amount != null ? formatCurrency(h.amount, h.currency || 'USD') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {historyMore.hasMore && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12 }}>
            <button className="btn btn-ghost btn-sm" disabled={historyLoadingMore} onClick={loadMoreHistory}>
              {historyLoadingMore ? <span className="spin spin-dark" /> : 'Load older'}
            </button>
          </div>
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
            const isCurrentTier = planTier === plan.key
            // FIX (deep audit, Billing re-pass — feature gap): a plan card
            // used to lock into static "Current plan" text purely on
            // planTier matching, with no regard for interval — so a
            // workspace paying monthly for Pro had no way to ever switch
            // to annual (or vice versa): the one button that could do it
            // was replaced by inert text the moment the tier matched,
            // regardless of which interval they were actually paying.
            // billing.plan_interval (migration 045) is what finally makes
            // "same tier, different interval" a distinguishable, buildable
            // state.
            const isExactCurrentPlan = isCurrentTier && planTier !== 'trial' && billing?.plan_interval
              ? billing.plan_interval === planInterval
              : isCurrentTier
            const isLoading = upgrading === plan.key
            return (
              <div key={plan.key} className={`tier-card${isExactCurrentPlan ? ' current' : ''}`}>
                <div className="tier-card-name">{plan.name}</div>
                <div className="tier-card-price">{plan.price[planInterval]}</div>
                <div className="tier-card-desc">
                  {plan.seats} seat{plan.seats > 1 ? 's' : ''} · {plan.projects ? `${plan.projects} active projects` : 'Unlimited projects'}
                </div>
                {isExactCurrentPlan ? (
                  <div style={{ marginTop: 12, fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>Current plan</div>
                ) : (
                  <button className="btn btn-ghost btn-sm"
                    style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}
                    disabled={!!upgrading}
                    onClick={() => handleUpgrade(plan.key)}>
                    {isLoading ? <span className="spin spin-dark" /> : (
                      isCurrentTier
                        // Same tier, different interval — this is a switch,
                        // not an upgrade or downgrade.
                        ? (planInterval === 'annual' ? 'Switch to annual' : 'Switch to monthly')
                        // FIX (deep audit, Settings re-pass): trial's 10-seat
                        // allowance is more generous than every paid tier
                        // except Agency, so comparing raw seat counts labelled
                        // every plan pick except Agency "Downgrade" during the
                        // trial period — exactly the moment a workspace is
                        // converting from trial to paid, the most common
                        // conversion in this whole flow. Trial isn't a real
                        // tier to downgrade from; picking any paid plan while
                        // on trial is always an upgrade (a first purchase).
                        : planTier === 'trial' || (PLAN_LIMITS[planTier]?.seats || 0) <= (PLAN_LIMITS[plan.key]?.seats || 0)
                          ? 'Upgrade' : 'Downgrade'
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
function NotificationsTab({ permissions }: { permissions: { manageWorkspace: boolean } }) {
  const [prefs,   setPrefs]   = useState<Record<string, boolean> | null>(null)
  // The bell channel of the EMAIL events (each can now be muted independently of its email).
  const [inAppPrefs, setInAppPrefs] = useState<Record<string, boolean>>({})
  const [locked,  setLocked]  = useState<Record<string, boolean>>({})
  const [saving,  setSaving]  = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [toggleErr, setToggleErr] = useState('')

  useEffect(() => {
    fetch('/api/notifications/preferences')
      .then(r => r.json())
      .then(json => {
        if (json.error) throw new Error(json.error)
        setPrefs(json.prefs)
        setInAppPrefs(json.inAppPrefs || {})
        setLocked(json.locked || {})
      })
      .catch(() => setLoadErr('Could not load notification preferences.'))
  }, [])

  // In-app-only events keep their single on/off state in `prefs` (the server
  // stores it in the in-app column and reports it there); only events that
  // also go out by email have a separate bell state in `inAppPrefs`.
  const inAppOnlyKeys = new Set<string>(IN_APP_NOTIF_ITEMS.map(i => i.key))

  async function toggle(key: string, channel: 'email' | 'in_app' = 'email') {
    if (!prefs || locked[key]) return
    const inAppOnly = inAppOnlyKeys.has(key)
    const isBell = !inAppOnly && channel === 'in_app'
    const current = isBell ? inAppPrefs[key] !== false : !!prefs[key]
    const next = !current
    const write = (v: boolean) => isBell
      ? setInAppPrefs(p => ({ ...p, [key]: v }))
      : setPrefs(p => ({ ...(p || {}), [key]: v }))
    write(next) // optimistic
    setToggleErr('')
    setSaving(`${key}:${channel}`)
    try {
      const res = await fetch('/api/notifications/preferences', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: key, enabled: next, channel: inAppOnly ? 'in_app' : channel }),
      })
      if (!res.ok) throw new Error()
    } catch {
      write(current) // revert on failure
      setToggleErr('Could not save that change — it has been put back. Try again.')
    } finally { setSaving(null) }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, marginBottom: 20 }}>Notifications</h2>
      <div className="settings-section">
        <div className="settings-section-title">Email notifications</div>
        {loadErr && <p className="ferr">{loadErr}</p>}
        {toggleErr && <p className="ferr">{toggleErr}</p>}
        {!prefs && !loadErr && <p style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</p>}
        {prefs && NOTIF_ITEMS.map(item => (
          <div key={item.key} className="settings-row">
            <div>
              <div className="settings-row-key">{item.label}</div>
              <div className="settings-row-desc">
                {item.desc}
                {/* FIX (deep audit, notifications section — flagship finding): a
                    workspace admin can now lock an event's default (see
                    app/api/workspace/notification-defaults) so an individual
                    can't silently suppress something mandatory — the toggle
                    needs to say why it's stuck rather than just not moving. */}
                {locked[item.key] && <span style={{ color: 'var(--text-3)' }}> — required by your workspace admin</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--text-3)' }}>
                Email
                <button
                  className={`toggle ${prefs[item.key] ? 'on' : 'off'}`}
                  aria-label={`${item.label}: email`}
                  disabled={saving === `${item.key}:email` || locked[item.key]}
                  style={locked[item.key] ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                  onClick={() => toggle(item.key, 'email')}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--text-3)' }}>
                Bell
                <button
                  className={`toggle ${inAppPrefs[item.key] !== false ? 'on' : 'off'}`}
                  aria-label={`${item.label}: in-app`}
                  disabled={saving === `${item.key}:in_app` || locked[item.key]}
                  style={locked[item.key] ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                  onClick={() => toggle(item.key, 'in_app')}
                />
              </label>
            </div>
          </div>
        ))}
      </div>

      {prefs && (
        <div className="settings-section" style={{ marginTop: 20 }}>
          <div className="settings-section-title">In-app notifications</div>
          <p style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '0 0 4px' }}>
            These never go out by email — only to the bell.
          </p>
          {IN_APP_NOTIF_ITEMS.map(item => (
            <div key={item.key} className="settings-row">
              <div>
                <div className="settings-row-key">{item.label}</div>
                <div className="settings-row-desc">
                  {item.desc}
                  {locked[item.key] && <span style={{ color: 'var(--text-3)' }}> — required by your workspace admin</span>}
                </div>
              </div>
              <button
                className={`toggle ${prefs[item.key] ? 'on' : 'off'}`}
                disabled={saving === `${item.key}:email` || saving === `${item.key}:in_app` || locked[item.key]}
                style={locked[item.key] ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                onClick={() => toggle(item.key, 'in_app')}
              />
            </div>
          ))}
        </div>
      )}

      {permissions.manageWorkspace && <WorkspaceNotificationDefaultsSection />}
    </div>
  )
}

// FIX (deep audit, notifications section — flagship finding): the
// admin-facing half of workspace_notification_defaults — see
// app/api/workspace/notification-defaults and filterByNotificationPreference
// (lib/utils/permissions-query.ts) for the schema this reads/writes and the
// read-side logic that makes it take effect. Reuses the same NOTIF_ITEMS/
// IN_APP_NOTIF_ITEMS label lists as the personal section above rather than
// a third copy.
function WorkspaceNotificationDefaultsSection() {
  const [defaults, setDefaults] = useState<Record<string, { emailEnabled: boolean; inAppEnabled: boolean; locked: boolean }> | null>(null)
  const [saving,   setSaving]   = useState<string | null>(null)
  const [loadErr,  setLoadErr]  = useState('')

  useEffect(() => {
    fetch('/api/workspace/notification-defaults')
      .then(r => r.json())
      .then(json => {
        if (json.error) throw new Error(json.error)
        setDefaults(json.defaults)
      })
      .catch(() => setLoadErr('Could not load workspace notification defaults.'))
  }, [])

  async function save(key: string, isInAppOnly: boolean, patch: { enabled?: boolean; locked?: boolean; inAppEnabled?: boolean }) {
    if (!defaults) return
    const current = defaults[key] || { emailEnabled: true, inAppEnabled: true, locked: false }
    const enabled = patch.enabled !== undefined ? patch.enabled : (isInAppOnly ? current.inAppEnabled : current.emailEnabled)
    const locked  = patch.locked !== undefined ? patch.locked : current.locked
    // The bell default of an EMAIL event — previously not settable by an admin at all.
    const inAppEnabled = patch.inAppEnabled
    const next = { ...current, locked, ...(isInAppOnly ? { inAppEnabled: enabled } : { emailEnabled: enabled }),
      ...(inAppEnabled !== undefined ? { inAppEnabled } : {}) }
    setDefaults(d => ({ ...(d || {}), [key]: next })) // optimistic
    setSaving(key)
    try {
      const res = await fetch('/api/workspace/notification-defaults', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: key, enabled, locked, ...(inAppEnabled !== undefined ? { inAppEnabled } : {}) }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setDefaults(d => ({ ...(d || {}), [key]: current })) // revert on failure
    } finally { setSaving(null) }
  }

  const allItems = [
    ...NOTIF_ITEMS.map(item => ({ ...item, inAppOnly: false })),
    ...IN_APP_NOTIF_ITEMS.map(item => ({ ...item, inAppOnly: true })),
  ]

  return (
    <div className="settings-section" style={{ marginTop: 20 }}>
      <div className="settings-section-title">Workspace defaults</div>
      <p style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '0 0 12px', lineHeight: 1.6 }}>
        Set the default for new and existing members, and optionally lock an event so it can&rsquo;t be
        turned off individually. Locking overrides any personal choice already made.
      </p>
      {loadErr && <p className="ferr">{loadErr}</p>}
      {!defaults && !loadErr && <p style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</p>}
      {defaults && allItems.map(item => {
        const d = defaults[item.key] || { emailEnabled: true, inAppEnabled: true, locked: false }
        const enabled = item.inAppOnly ? d.inAppEnabled : d.emailEnabled
        return (
          <div key={item.key} className="settings-row" style={{ alignItems: 'center' }}>
            <div>
              <div className="settings-row-key">{item.label}</div>
              <div className="settings-row-desc">{item.desc}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-2)' }}>
                <input
                  type="checkbox" checked={d.locked} disabled={saving === item.key}
                  onChange={e => save(item.key, item.inAppOnly, { locked: e.target.checked })}
                />
                Lock
              </label>
              {!item.inAppOnly && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-3)' }}>
                  Bell
                  <button
                    className={`toggle ${d.inAppEnabled ? 'on' : 'off'}`} aria-label={`${item.label}: bell default`}
                    disabled={saving === item.key}
                    onClick={() => save(item.key, false, { inAppEnabled: !d.inAppEnabled })}
                  />
                </span>
              )}
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-3)' }}>
                {item.inAppOnly ? 'Bell' : 'Email'}
                <button
                  className={`toggle ${enabled ? 'on' : 'off'}`} aria-label={`${item.label}: ${item.inAppOnly ? 'bell' : 'email'} default`}
                  disabled={saving === item.key}
                  onClick={() => save(item.key, item.inAppOnly, { enabled: !enabled })}
                />
              </span>
            </div>
          </div>
        )
      })}
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
function DangerTab({ workspace, permissions, session }: any) {
  const router   = useRouter()
  const supabase = createClient()
  const [confirm,  setConfirm]  = useState('')
  const [deleting, setDeleting] = useState(false)
  const [err,      setErr]      = useState('')

  if (!permissions.manageWorkspace) return <Restricted />

  // FIX (deep audit, Settings section — HIGH): the delete gate is a
  // string comparison against the workspace name, and an empty workspace
  // name used to be a perfectly valid save (see the non-empty check now
  // added to api/workspace/settings/route.ts). With name === '', the
  // empty untouched input EQUALS the workspace name — so the
  // type-to-confirm step vanished entirely and "Delete workspace
  // permanently" was live on page load. The server-side fix closes the
  // way in; this makes the gate itself refuse to be satisfied by a blank
  // value regardless of how the workspace got one.
  const confirmName = (workspace?.name || '').trim()
  const canDelete = !!confirmName && confirm.trim() === confirmName

  async function handleDelete() {
    if (!canDelete) return
    setDeleting(true); setErr('')
    try {
      const res  = await fetchWithStepUp('/api/workspace/delete', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: confirm.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      // FIX (deep audit, Auth+MFA re-pass — signOut scope): this used to
      // call the bare, unscoped supabase.auth.signOut(), which defaults to
      // scope: 'global' — revoking every session on every device the
      // account is signed into, not just this one. The account itself
      // isn't gone (only this one workspace is), and /api/workspace/delete
      // has already reassigned this user's own active_workspace_id to a
      // valid fallback workspace if they have one — there's no security
      // reason tied to THIS action to sign out anywhere but here. Same bug
      // class already found and fixed for the ordinary "Sign out" button
      // and the old /api/auth/signout route; this call site was missed.
      await supabase.auth.signOut({ scope: 'local' })
      router.push('/login?message=Workspace+deleted.')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not delete workspace')
    } finally { setDeleting(false) }
  }

  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
  // gap): there was previously no UI for this at all, because the
  // capability didn't exist — see migration 039 for why it needed to.
  // Only rendered for the actual current owner (workspace.created_by),
  // not just anyone with MANAGE_WORKSPACE_SETTINGS — same reasoning
  // complete-onboarding already uses to scope itself to the creator.
  const isOwner = !!session?.id && workspace?.created_by === session.id

  return (
    <div>
      <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 22, fontWeight: 400, color: 'var(--red)', marginBottom: 20 }}>Danger zone</h2>
      {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}
      {isOwner && <TransferOwnershipSection />}
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
        {!confirmName && (
          <p className="ferr" style={{ marginBottom: 10 }}>
            This workspace has no name set, so it can&rsquo;t be confirmed for deletion. Give it a name on the
            Workspace tab first.
          </p>
        )}
        <button className="btn btn-danger btn-sm"
          disabled={!canDelete || deleting}
          onClick={handleDelete}>
          {deleting ? <span className="spin" /> : 'Delete workspace permanently'}
        </button>
      </div>
    </div>
  )
}

function TransferOwnershipSection() {
  const [loading,  setLoading]  = useState(true)
  const [members,  setMembers]  = useState<Array<{ id: string; name: string; email: string }>>([])
  const [selected, setSelected] = useState('')
  const [confirm,  setConfirm]  = useState(false)
  const [busy,     setBusy]     = useState(false)
  const [err,      setErr]      = useState('')
  const [done,     setDone]     = useState(false)

  useEffect(() => {
    fetch('/api/workspace/transfer-ownership')
      .then(r => r.json())
      .then(json => setMembers(Array.isArray(json.eligibleMembers) ? json.eligibleMembers : []))
      .catch(() => setErr('Could not load eligible members.'))
      .finally(() => setLoading(false))
  }, [])

  async function handleTransfer() {
    if (!selected || !confirm) return
    setBusy(true); setErr('')
    try {
      const res  = await fetchWithStepUp('/api/workspace/transfer-ownership', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newOwnerUserId: selected }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not transfer ownership')
      setDone(true)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not transfer ownership')
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="settings-section" style={{ marginBottom: 20 }}>
        <div className="settings-section-title">Transfer ownership</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)' }}>Ownership has been transferred. Refresh to see the change reflected.</p>
      </div>
    )
  }

  return (
    <div className="settings-section" style={{ marginBottom: 20 }}>
      <div className="settings-section-title">Transfer ownership</div>
      <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 16 }}>
        Hand this workspace off to another team member permanently. They must already hold the
        &ldquo;Manage workspace settings&rdquo; permission (Team &gt; Roles). You&rsquo;ll remain a member,
        but they become the workspace&rsquo;s owner of record.
      </p>
      {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}
      {loading ? (
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>Loading eligible members&hellip;</p>
      ) : members.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
          No other active member currently holds &ldquo;Manage workspace settings&rdquo;. Grant it to someone
          under Team &gt; Roles first.
        </p>
      ) : (
        <>
          <div className="fgrp">
            <label className="flbl">New owner</label>
            <select className="finp" value={selected} onChange={e => setSelected(e.target.value)}>
              <option value="">Select a member&hellip;</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.name || m.email} ({m.email})</option>
              ))}
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-2)', margin: '10px 0 16px' }}>
            <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
            I understand this cannot be undone from here &mdash; the new owner would need to transfer it back.
          </label>
          <button className="btn btn-secondary btn-sm" disabled={!selected || !confirm || busy} onClick={handleTransfer}>
            {busy ? <span className="spin" /> : 'Transfer ownership'}
          </button>
        </>
      )}
    </div>
  )
}


function Restricted({ need = 'MANAGE_WORKSPACE_SETTINGS' }: { need?: string }) {
  return (
    <div className="surface surface-p" style={{ textAlign: 'center', padding: 48 }}>
      <i className="ti ti-lock" style={{ fontSize: 28, color: 'var(--text-4)', display: 'block', marginBottom: 12 }} />
      <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-2)', marginBottom: 6 }}>Access restricted</p>
      <p style={{ fontSize: 12, color: 'var(--text-3)' }}>You need the {need} permission to view this section.</p>
    </div>
  )
}
