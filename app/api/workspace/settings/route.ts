export const runtime = 'nodejs'

import { isDeliverableAddress } from '@/lib/email/send'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { INDUSTRIES, CURRENCIES } from '@/lib/constants/workspace-options'
import { isValidTimeZone } from '@/lib/utils/timezone'
import { diffFields, sameValue } from '@/lib/utils/audit-diff'

// API field name -> workspaces column.
const COLUMNS: Record<string, string> = {
  name:                       'name',
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
// free text that can carry bank or tax details.
const AUDIT_REDACT = ['taxId', 'defaultPaymentInstructions', 'phone']

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
      const v = requireString(value, 'Governing law').trim()
      if (v.length > 200) throw new FieldError('Governing law must be under 200 characters')
      return v
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
      const parsed = typeof value === 'number' ? value : parseFloat(String(value))
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
      const n = typeof value === 'number' ? value : Number(String(value).trim())
      if (!Number.isInteger(n) || n < min || n > max)
        throw new FieldError(`${label} must be a whole number from ${min} to ${max}`)
      return n
    }
    case 'replyToEmail': {
      const v = typeof value === 'string' ? value.trim() : ''
      if (v === '') return null
      if (v.length > 254 || !isDeliverableAddress(v)) throw new FieldError('Enter a valid reply-to email address')
      return v
    }
    case 'defaultTaxRate': {
      // Pre-fills every new invoice / change order (Billing defaults). Numeric(5,2) in the DB.
      const n = typeof value === 'number' ? value : Number(String(value).trim())
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
      const n = typeof value === 'number' ? value : Number(String(value).trim())
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
        if (typeof raw !== 'string') continue
        const trimmed = raw.trim()
        if (trimmed.length > 200) throw new FieldError(`Address ${field} must be under 200 characters`)
        if (trimmed) clean[field] = trimmed
      }
      return clean
    }
    default: {
      const spec = OPTIONAL_TEXT[key]
      if (!spec) throw new FieldError(`Unknown setting: ${key}`)
      if (value === null) return null
      const v = requireString(value, spec.label).trim()
      if (v.length > spec.max) throw new FieldError(`${spec.label} must be under ${spec.max} characters`)
      return v
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

    // `expected` carries the values the editor loaded for the fields it is
    // sending. If the row has moved on since, the save is refused rather than
    // silently overwriting a colleague's change.
    const expected = (body as any).expected
    if (expected !== undefined && (expected === null || typeof expected !== 'object' || Array.isArray(expected)))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    const service = createServiceClient()

    const { data: current, error: currentErr } = await (service as any)
      .from('workspaces')
      .select(`${Object.values(COLUMNS).join(', ')}, updated_at`)
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

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const key of changedKeys) updates[COLUMNS[key]] = proposed[key]

    // Compare-and-swap on updated_at: the conflict check above and this write are two round
    // trips, so two admins saving in the same instant could both pass it. Only write if the row
    // is still the one we read.
    let write = (service as any).from('workspaces').update(updates).eq('id', session.workspaceId)
    if (current.updated_at) write = write.eq('updated_at', current.updated_at)
    const { data: written, error } = await write.select('id')

    if (error) {
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
      metadata: { fields: changedKeys, changes },
    })

    return NextResponse.json({ ok: true, changed: changedKeys, values: proposed })
  } catch (err) {
    if (err instanceof FieldError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('Workspace settings error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
