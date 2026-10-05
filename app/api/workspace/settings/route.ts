export const runtime = 'nodejs'

import { isValidReplyTo } from '@/lib/email/send'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { generateSlug } from '@/lib/utils/workspace-slug'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { INDUSTRIES, CURRENCIES } from '@/lib/constants/workspace-options'
import { isValidTimeZone, formatDateInZone } from '@/lib/utils/timezone'
import { diffFields, sameValue } from '@/lib/utils/audit-diff'
import { stripUnstorableText } from '@/lib/utils/sanitize'
import { isBlankText } from '@/lib/utils/client-input'

// FEATURE (deep audit, Settings independent re-pass — feature gap):
// workspaces.slug/slug_changed_at (migration 001) have existed since day
// one — generated once at creation (workspace/create/route.ts) and never
// read back or exposed anywhere since. slug_changed_at in particular was
// never written by anything at all, which only makes sense as the
// leftover half of a rename feature that was never finished. Give it the
// one it was clearly built for: an editable workspace handle, rate-
// limited by slug_changed_at the same way the column name implies. See
// this route's slug case in parseField and the rate-limit/uniqueness
// handling in PATCH below, and app/api/reports/{export,audit-export,
// portfolio/export} for the three places that used to re-derive their
// own throwaway version of this instead of reading the real one.
const SLUG_MIN_DAYS_BETWEEN_CHANGES = 30

function isValidSlug(v: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) && v.length >= 3 && v.length <= 50
}

// API field name -> workspaces column.
const COLUMNS: Record<string, string> = {
  name:                       'name',
  slug:                       'slug',
  agencyName:                 'agency_name',
  industry:                   'industry',
  currency:                   'currency',
  timezone:                   'timezone',
  sowLanguage:                'sow_language',
  governingLaw:               'governing_law',
  guardianSensitivityTier:    'guardian_sensitivity_tier',
  proactiveRiskAlertsEnabled: 'proactive_risk_alerts_enabled',
  proactiveRiskThreshold:     'proactive_risk_threshold',
  autoClientReminders:        'auto_client_reminders',
  clientReminderAfterDays:    'client_reminder_after_days',
  clientReminderMax:          'client_reminder_max',
  taxId:                      'tax_id',
  phone:                      'phone',
  website:                    'website',
  defaultPaymentInstructions: 'default_payment_instructions',
  replyToEmail:               'reply_to_email',
  legalAddress:               'legal_address',
  defaultTaxRate:             'default_tax_rate',
  defaultTaxInclusive:        'default_tax_inclusive',
  defaultPaymentTermsDays:    'default_payment_terms_days',
}

// Recorded as "changed" in the audit trail without the value: identifiers and
// free text that can carry bank, tax, or contact details.
// FIX (deep audit, Settings independent re-pass): legalAddress belongs here
// by the exact rationale this list already exists for — a full registered/
// mailing address is at least as identifying as a phone number, but unlike
// taxId/defaultPaymentInstructions/phone it was never added, so every edit
// to it was written verbatim (from/to, full street+city+region+postal+
// country) into workspace.settings_updated audit metadata — readable by
// anyone holding VIEW_AUDIT_LOG alone (no MANAGE_WORKSPACE_SETTINGS
// required) and included as-is in JSON/CSV/PDF audit exports, since
// lib/audit/redact.ts's money-word matcher has no reason to catch address
// fields either.
// FIX (Settings independent pass 7): replyToEmail is a contact address, the same class as phone — it was written
// verbatim (from/to) into audit metadata readable with VIEW_AUDIT_LOG alone and exported as-is.
const AUDIT_REDACT = ['taxId', 'defaultPaymentInstructions', 'phone', 'legalAddress', 'replyToEmail']

const SUPPORTED_SOW_LANGUAGES = ['en', 'es', 'fr', 'pt', 'de', 'sw']
const SENSITIVITY_TIERS = ['conservative', 'medium', 'aggressive']

// Optional text columns: a string (trimmed, length-capped) or null.
const OPTIONAL_TEXT: Record<string, { label: string; max: number }> = {
  taxId:                      { label: 'Tax ID', max: 50 },
  phone:                      { label: 'Phone', max: 40 },
  website:                    { label: 'Website', max: 200 },
  defaultPaymentInstructions: { label: 'Default payment instructions', max: 2000 },
}

class FieldError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

// FIX (Settings independent pass 12): the numeric fields coerced with String(value), so a direct API call could
// save [5] as 5, or (threshold) '12abc' as 12 via parseFloat. Only a number, or a non-blank numeric string, counts.
function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value.trim())
  return NaN
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new FieldError(`${label} must be text`)
  return value
}

/** Validate and normalise one client-supplied field. Throws FieldError. */
function parseField(key: string, value: unknown): unknown {
  switch (key) {
    case 'name': {
      const v = sanitizeDisplayName(requireString(value, 'Workspace name'))
      if (!v.trim()) throw new FieldError('Workspace name is required')
      return v
    }
    case 'slug': {
      const v = requireString(value, 'Workspace handle').trim().toLowerCase()
      if (!isValidSlug(v))
        throw new FieldError('Workspace handle must be 3\u201350 characters: lowercase letters, numbers, and single hyphens between them, with no leading or trailing hyphen')
      return v
    }
    case 'agencyName': {
      const v = sanitizeDisplayName(requireString(value, 'Agency name'))
      if (!v.trim()) throw new FieldError('Agency name is required')
      return v
    }
    case 'industry': {
      // FIX (fresh independent audit, Workspace lifecycle + Onboarding):
      // this only ever length-checked the value — unlike workspace/create,
      // which validates against the curated INDUSTRIES list specifically
      // because "the UI presents fixed dropdowns... nothing stopped a
      // direct API call from storing an unrecognized industry" (see that
      // route's own comment). This route is hit by the exact same field
      // from the exact same wizard's own step-0 "go back and edit" path
      // (submitIdentity PATCHes here once workspaceId already exists) —
      // the dropdown protects a normal browser user, but any direct API
      // call bypassed the enum check entirely and could set an industry
      // the app never offers. Validate against the same curated list.
      const v = requireString(value, 'Industry').trim()
      if (!(INDUSTRIES as readonly string[]).includes(v)) throw new FieldError('Invalid industry')
      return v
    }
    case 'currency': {
      const v = requireString(value, 'Currency')
      if (!(CURRENCIES as readonly string[]).includes(v)) throw new FieldError('Invalid currency')
      return v
    }
    case 'timezone': {
      const v = requireString(value, 'Timezone').trim()
      if (v !== '' && !isValidTimeZone(v)) throw new FieldError('Invalid timezone')
      return v
    }
    case 'sowLanguage': {
      const raw = requireString(value, 'SOW language')
      const base = raw.replace('_', '-').split('-')[0].toLowerCase()
      if (!SUPPORTED_SOW_LANGUAGES.includes(base)) throw new FieldError('Unsupported SOW language')
      return base
    }
    case 'governingLaw': {
      const v = stripUnstorableText(requireString(value, 'Governing law')).trim()
      if (v.length > 200) throw new FieldError('Governing law must be under 200 characters')
      // FIX (Settings independent pass 12): zero-width / bidi / control characters survive trim(), so a value made of
      // nothing visible was stored and then passed sow/generate's "governing law is set" hard-block. Blank means unset.
      return isBlankText(v) ? '' : v
    }
    case 'guardianSensitivityTier': {
      const v = requireString(value, 'Guardian sensitivity tier')
      if (!SENSITIVITY_TIERS.includes(v)) throw new FieldError('Invalid Guardian sensitivity tier')
      return v
    }
    case 'proactiveRiskAlertsEnabled':
      if (typeof value !== 'boolean') throw new FieldError('Risk alerts setting must be true or false')
      return value
    case 'proactiveRiskThreshold': {
      const parsed = toFiniteNumber(value)
      if (!Number.isFinite(parsed) || parsed < 0) throw new FieldError('Risk threshold must be a number of 0 or more')
      return parsed
    }
    case 'autoClientReminders':
      if (typeof value !== 'boolean') throw new FieldError('Automatic client reminders must be true or false')
      return value
    case 'clientReminderAfterDays':
    case 'clientReminderMax': {
      const [label, min, max] = key === 'clientReminderAfterDays'
        ? ['Days between reminders', 1, 30] as const
        : ['Maximum reminders', 1, 10] as const
      const n = toFiniteNumber(value)
      if (!Number.isInteger(n) || n < min || n > max)
        throw new FieldError(`${label} must be a whole number from ${min} to ${max}`)
      return n
    }
    case 'replyToEmail': {
      // FIX (Settings independent pass 11, bug 2): a non-string value (number, boolean, object) was coerced to '' and so
      // silently CLEARED the saved reply-to address with a 200. Only null / a blank string mean "clear"; anything else
      // that isn't an address is a 400, like every other field.
      if (value !== null && typeof value !== 'string') throw new FieldError('Enter a valid reply-to email address')
      const v = value === null ? '' : value.trim()
      if (v === '') return null
      // Settings independent pass 14: strict pattern (rejects NUL / lone surrogates / invisible characters / `..` / trailing
      // punctuation) — the loose delivery check let those through to a 500 or to a malformed Reply-To on every email.
      if (v.length > 254 || !isValidReplyTo(v)) throw new FieldError('Enter a valid reply-to email address')
      return v
    }
    case 'defaultTaxRate': {
      // Pre-fills every new invoice / change order (Billing defaults). Numeric(5,2) in the DB.
      const n = toFiniteNumber(value)
      if (String(value).trim() === '' || !Number.isFinite(n) || n < 0 || n > 100)
        throw new FieldError('Default tax rate must be a number from 0 to 100')
      return Math.round(n * 100) / 100
    }
    case 'defaultTaxInclusive':
      if (typeof value !== 'boolean') throw new FieldError('Tax inclusive setting must be true or false')
      return value
    case 'defaultPaymentTermsDays': {
      // null / blank = no default due date.
      if (value === null || (typeof value === 'string' && value.trim() === '')) return null
      const n = toFiniteNumber(value)
      if (!Number.isInteger(n) || n < 0 || n > 365)
        throw new FieldError('Payment terms must be a whole number of days from 0 to 365')
      return n
    }
    case 'legalAddress': {
      if (value === null) return null
      if (typeof value !== 'object' || Array.isArray(value)) throw new FieldError('Invalid legal address')
      const clean: Record<string, string> = {}
      for (const field of ['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const) {
        const raw = (value as Record<string, unknown>)[field]
        if (raw === undefined || raw === null) continue
        // FIX (Settings independent pass 12): a non-string part was silently dropped with a 200.
        if (typeof raw !== 'string') throw new FieldError(`Address ${field} must be text`)
        const trimmed = stripUnstorableText(raw).trim()
        if (trimmed.length > 200) throw new FieldError(`Address ${field} must be under 200 characters`)
        // Invisible-only parts are blank, like an empty box.
        if (trimmed && !isBlankText(trimmed)) clean[field] = trimmed
      }
      return clean
    }
    default: {
      const spec = OPTIONAL_TEXT[key]
      if (!spec) throw new FieldError(`Unknown setting: ${key}`)
      if (value === null) return null
      // FIX (Settings independent pass 7): a pasted NUL or half-emoji made Postgres reject the whole save (generic 500).
      const v = stripUnstorableText(requireString(value, spec.label)).trim()
      if (v.length > spec.max) throw new FieldError(`${spec.label} must be under ${spec.max} characters`)
      return isBlankText(v) ? null : v
    }
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    // FIX (deep audit, Onboarding round — traced multi-tab/multi-session
    // staleness risk): this route deliberately writes to session.workspaceId
    // rather than any client-supplied ID, to defeat a confused-deputy risk
    // already hardened in the resume flow — the onboarding wizard doesn't
    // send its own workspaceId here at all today. But the compare-and-swap
    // below only catches a colleague editing the SAME row concurrently; it
    // can't catch the session's active workspace having moved to a
    // DIFFERENT, entirely valid workspace out from under a stale tab (e.g. a
    // second tab or device that discarded or restored a workspace mid-
    // wizard) — that just looks like an ordinary update of that other row.
    // When the caller does tell us which workspace it thinks it's editing,
    // require it to match — a visible, safe refusal instead of a silent
    // misdirected write.
    const expectedWorkspaceId = (body as any).workspaceId
    if (expectedWorkspaceId !== undefined && expectedWorkspaceId !== session.workspaceId) {
      return NextResponse.json({
        error: 'You\u2019re no longer working on that workspace. Reload the page and try again.',
      }, { status: 409 })
    }

    // `expected` carries the values the editor loaded for the fields it is
    // sending. If the row has moved on since, the save is refused rather than
    // silently overwriting a colleague's change.
    const expected = (body as any).expected
    if (expected !== undefined && (expected === null || typeof expected !== 'object' || Array.isArray(expected)))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    const service = createServiceClient()

    // slug_changed_at isn't itself a settable field (it's not in COLUMNS —
    // nothing accepts it from the client), but the slug rate-limit check
    // below needs to read it alongside everything else.
    const { data: current, error: currentErr } = await (service as any)
      .from('workspaces')
      .select(`${Object.values(COLUMNS).join(', ')}, slug_changed_at, onboarding_completed_at, updated_at`)
      .eq('id', session.workspaceId).single()
    if (currentErr || !current) {
      console.error('Workspace settings: could not load workspace:', currentErr)
      return NextResponse.json({ error: 'Failed to update workspace settings' }, { status: 500 })
    }

    // Current values keyed by API field name, for diffing and conflict checks.
    const currentByKey: Record<string, unknown> = {}
    for (const [key, col] of Object.entries(COLUMNS)) currentByKey[key] = current[col]

    // Validate everything that was sent.
    const proposed: Record<string, unknown> = {}
    for (const key of Object.keys(COLUMNS)) {
      if ((body as any)[key] === undefined) continue
      proposed[key] = parseField(key, (body as any)[key])
    }

    const { changedKeys, changes } = diffFields(currentByKey, proposed, AUDIT_REDACT)

    if (expected) {
      const conflicts = changedKeys.filter(k =>
        (expected as Record<string, unknown>)[k] !== undefined &&
        !sameValue((expected as Record<string, unknown>)[k], currentByKey[k]))
      if (conflicts.length > 0) {
        return NextResponse.json({
          error: 'These settings were changed by someone else while you were editing. Reload the page to see the latest values, then re-apply your change.',
          conflicts,
        }, { status: 409 })
      }
    }

    // The values as the server will store them (trimmed, whitespace-collapsed, length-capped, …).
    // The editor re-baselines its conflict check on THESE, not on what it typed — otherwise a
    // value the server normalised ("Acme  Studio" → "Acme Studio") makes the very next edit of
    // the same field look like a concurrent change by someone else.
    if (changedKeys.length === 0) return NextResponse.json({ ok: true, unchanged: true, values: proposed })

    // The handle is a link surface (report filenames read it back — see the
    // FEATURE comment above COLUMNS), so it isn't rewritten freely: rate-
    // limited by slug_changed_at the same way the column name implies it
    // was always meant to be, mirroring every other cooldown pattern in
    // this codebase that gates a re-issue by "when did this last change."
    if (changedKeys.includes('slug') && current.slug_changed_at) {
      const nextAllowed = new Date(current.slug_changed_at).getTime() + SLUG_MIN_DAYS_BETWEEN_CHANGES * 24 * 60 * 60 * 1000
      if (nextAllowed > Date.now()) {
        // FIX (Settings independent pass, minor): this used the server process's locale and timezone
        // (the runtime default locale formatter), so the date could be a day off and in the wrong format for the agency.
        // Format it in the workspace's own timezone like every other date in the app.
        return NextResponse.json({
          error: `The workspace handle can be changed once every ${SLUG_MIN_DAYS_BETWEEN_CHANGES} days. It can next be changed on ${formatDateInZone(nextAllowed, current.timezone)}.`,
        }, { status: 409 })
      }
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const key of changedKeys) updates[COLUMNS[key]] = proposed[key]
    if (changedKeys.includes('slug')) updates.slug_changed_at = new Date().toISOString()

    // Onboarding independent pass 9: the wizard's first step creates the workspace with a handle derived
    // from the name typed at that moment, then (on Back + Continue) renames it through this route. The
    // handle never followed, so a typo fixed on Back stayed in the handle — which report filenames read
    // back. While the workspace is still unfinished AND its handle has never been set by a person
    // (slug_changed_at is null, so it is still the auto-generated one), derive it again from the new name.
    // slug_changed_at is deliberately NOT stamped: this is the system keeping its own default in step, and
    // stamping it would burn the owner's first free change and put the 30-day cooldown on a handle they
    // never chose. An explicit slug in the same request wins (changedKeys already carries it).
    let autoSlug = false
    if (changedKeys.includes('name') && !('slug' in proposed) &&
        !current.onboarding_completed_at && !current.slug_changed_at &&
        typeof proposed.name === 'string' && proposed.name) {
      updates.slug = generateSlug(proposed.name)
      autoSlug = true
    }

    // FIX (independent re-audit, Settings section — flagship finding):
    // proactive_risk_threshold is a bare number with no currency of its own —
    // it's implicitly denominated in whatever workspaces.currency happens to
    // be at read time (see lib/utils/attention.ts, which only compares it
    // against a project when the PROJECT's currency matches the workspace's —
    // a fix for the exact same class of bug, just on the other side of this
    // comparison). Nothing stopped the workspace's OWN currency from changing
    // out from under an already-saved threshold: the identical number that
    // meant "$10,000" a moment ago silently means "KES 10,000" (~$77) the
    // instant this save lands, with nothing in the response, the UI, or the
    // audit log telling anyone their alert threshold just changed meaning.
    // Depending on the direction, that either floods the workspace with
    // false "high-value project, no signed SOW" alerts or quietly disables
    // a real one. Whenever currency changes and the caller isn't ALSO
    // explicitly setting a new threshold in this same request, reset it back
    // to the column default (migration 001) so the number always describes a
    // value in TODAY's currency, and say so in the response — recoverable
    // and visible, never a threshold that quietly means something else.
    const DEFAULT_RISK_THRESHOLD = 10000
    const thresholdExplicitlySet = Object.prototype.hasOwnProperty.call(proposed, 'proactiveRiskThreshold')
    let thresholdReset = false
    if (changedKeys.includes('currency') && !thresholdExplicitlySet &&
        Number(currentByKey.proactiveRiskThreshold ?? DEFAULT_RISK_THRESHOLD) !== DEFAULT_RISK_THRESHOLD) {
      updates.proactive_risk_threshold = DEFAULT_RISK_THRESHOLD
      changedKeys.push('proactiveRiskThreshold')
      changes.proactiveRiskThreshold = { from: currentByKey.proactiveRiskThreshold, to: DEFAULT_RISK_THRESHOLD }
      proposed.proactiveRiskThreshold = DEFAULT_RISK_THRESHOLD
      thresholdReset = true
    }

    // Compare-and-swap on updated_at: the conflict check above and this write are two round
    // trips, so two admins saving in the same instant could both pass it. Only write if the row
    // is still the one we read.
    const attemptWrite = (baseUpdatedAt: string | null | undefined) => {
      let w = (service as any).from('workspaces').update(updates).eq('id', session.workspaceId)
      if (baseUpdatedAt) w = w.eq('updated_at', baseUpdatedAt)
      return w.select('id')
    }
    let baseUpdatedAt: string | null | undefined = current.updated_at
    let { data: written, error } = await attemptWrite(baseUpdatedAt)

    // The auto-generated handle's 6-character suffix collided with an existing one (≈1 in 2 billion per
    // name) — draw another instead of failing a rename the person made no mistake in.
    if (error && (error as any).code === '23505' && autoSlug) {
      updates.slug = generateSlug(proposed.name as string)
      ;({ data: written, error } = await attemptWrite(baseUpdatedAt))
    }

    // Settings pass (bug 7): losing the compare-and-swap above is not always a real conflict. updated_at is moved by
    // every write to the workspace row — a billing webhook, a logo upload, the defaults governing-law write-through —
    // so a save could be refused as "changed by someone else at the same moment" although nothing it writes had
    // changed (and the editor's own per-field `expected` check had already passed). Branding re-reads and retries in
    // that case; do the same here: re-read, and write again against the new timestamp only if none of the fields this
    // save touches (nor the handle cooldown / onboarding state it depends on) differ from what was read the first time.
    for (let attempt = 0; attempt < 2 && !error && (!written || written.length === 0); attempt++) {
      const { data: fresh, error: freshErr } = await (service as any)
        .from('workspaces')
        .select(`${Object.values(COLUMNS).join(', ')}, slug_changed_at, onboarding_completed_at, updated_at`)
        .eq('id', session.workspaceId).single()
      if (freshErr || !fresh) break
      const touched = changedKeys.map(k => COLUMNS[k])
      const sameRow = [...touched, 'slug_changed_at', 'onboarding_completed_at']
        .every(col => sameValue(fresh[col], (current as any)[col]))
      if (!sameRow) break
      baseUpdatedAt = fresh.updated_at
      ;({ data: written, error } = await attemptWrite(baseUpdatedAt))
    }

    if (error) {
      // workspaces.slug is UNIQUE (migration 001) — someone else already holds it.
      if ((error as any).code === '23505' && changedKeys.includes('slug'))
        return NextResponse.json({ error: 'That workspace handle is already taken. Try another.' }, { status: 409 })
      console.error('Workspace settings update failed:', error)
      return NextResponse.json({ error: 'Failed to update workspace settings' }, { status: 500 })
    }
    if (!written || written.length === 0) {
      return NextResponse.json({
        error: 'These settings were changed by someone else at the same moment. Reload the page to see the latest values, then re-apply your change.',
        conflicts: [],
      }, { status: 409 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.settings_updated', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { fields: changedKeys, changes, ...(autoSlug ? { slugRegenerated: true } : {}) },
    })

    return NextResponse.json({
      ok: true, changed: changedKeys, values: proposed,
      ...(thresholdReset ? {
        thresholdReset: true,
        warning: `Your currency changed, so the Guardian risk-alert threshold has been reset to ${DEFAULT_RISK_THRESHOLD.toLocaleString()} in the new currency. Review it under Settings \u2192 Guardian.`,
      } : {}),
    })
  } catch (err) {
    if (err instanceof FieldError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('Workspace settings error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
