import { isDeliverableAddress } from '@/lib/email/send'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { CURRENCIES } from '@/lib/constants/workspace-options'

// FIX (deep audit, Settings re-pass): a real IANA zone check, not the
// small curated TIMEZONES list in lib/constants/workspace-options.ts.
// That list was built for onboarding's own quick-pick dropdown (12
// zones); this route also serves Settings' Workspace tab, whose own
// timezone <select> is intentionally the FULL IANA list
// (Intl.supportedValuesOf('timeZone') client-side — see
// components/settings/SettingsClient.tsx's IANA_TIMEZONES). Validating a
// save from that full-range picker against the narrow onboarding list
// rejected the vast majority of real, correctly-selected timezones
// (anything outside the original 12, e.g. "UTC" or "America/Chicago" or
// "Asia/Tokyo") with a false "Invalid timezone" — a regression introduced
// the moment the onboarding-round-4 fix reused this constant here.
function isValidIanaTimezone(tz: string): boolean {
  try {
    if (typeof (Intl as any).supportedValuesOf === 'function') {
      return ((Intl as any).supportedValuesOf('timeZone') as string[]).includes(tz)
    }
  } catch { /* fall through to the format-based check below */ }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch { return false }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })

    const body    = await request.json()
    const service = createServiceClient()
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

    // Map camelCase input to snake_case columns
    const fieldMap: Record<string, string> = {
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
      // Automatic client reminders (cron/client-reminders) — opt-in, migration 062.
      autoClientReminders:        'auto_client_reminders',
      clientReminderAfterDays:    'client_reminder_after_days',
      clientReminderMax:          'client_reminder_max',
      // Document billing identity (Phase 11) — printed on SOW/CO/Invoice PDFs.
      // All optional: a workspace that hasn't filled these in yet still
      // generates documents fine, the renderer just omits the block.
      taxId:                      'tax_id',
      phone:                      'phone',
      website:                    'website',
      defaultPaymentInstructions: 'default_payment_instructions',
    }

    for (const [key, col] of Object.entries(fieldMap)) {
      if (body[key] !== undefined) updates[col] = body[key]
    }

    // FIX (deep audit, section 5 re-pass): completes the SOW-language
    // feature (see components/settings/SettingsClient.tsx and
    // lib/ai/sow-content.ts). Validate against the curated set the
    // generator actually has boilerplate translations for — an
    // unrecognized code would otherwise silently fall back to English at
    // generation time with no indication anything was wrong.
    // FIX (deep audit, Settings section — CRITICAL): this rejected the
    // value the DATABASE ITSELF produces. workspaces.sow_language was
    // `NOT NULL DEFAULT 'en-US'` (001, line 54) and create_workspace_atomic
    // never set the column, so every workspace ever created sat at
    // 'en-US' — which is not in this list. Because Settings \u2192 Workspace
    // posts the whole form object on save (both its buttons send `form`,
    // seeded from this column), that made the ENTIRE tab \u2014 Identity and
    // Billing identity alike \u2014 unsaveable on any workspace that had never
    // explicitly touched the language field: change the agency name, hit
    // save, get back "Unsupported SOW language" naming a field you never
    // touched. The <select> hid it completely, since 'en-US' matches no
    // <option> and the browser just paints the first one ("English").
    //
    // Migration 054 normalizes the stored data, fixes the default and adds
    // a CHECK constraint. This normalizes defensively on the way in too,
    // so a regional code from a stale client or an old bookmark is coerced
    // onto its base language rather than 400ing the whole form.
    if (typeof updates.sow_language === 'string') {
      const SUPPORTED_SOW_LANGUAGES = ['en', 'es', 'fr', 'pt', 'de', 'sw']
      const base = updates.sow_language.replace('_', '-').split('-')[0].toLowerCase()
      if (!SUPPORTED_SOW_LANGUAGES.includes(base)) {
        return NextResponse.json({ error: 'Unsupported SOW language' }, { status: 400 })
      }
      updates.sow_language = base
    }

    // FIX (deep audit, Settings section \u2014 validation gap): these two were
    // the only mapped fields on this route with no server-side check at
    // all. Every other constrained column here got one in an earlier pass
    // (sow_language, guardian_sensitivity_tier, currency, timezone,
    // industry, the four TEXT_FIELD_LIMITS columns, legal_address) \u2014
    // these were simply skipped. proactive_risk_threshold is
    // `decimal NOT NULL` and proactive_risk_alerts_enabled is
    // `boolean NOT NULL` (001), so a non-numeric threshold, an explicit
    // null, or a string boolean produced a raw Postgres type/NOT-NULL
    // error that surfaced as an opaque 500, and a negative threshold
    // persisted silently. GuardianTab's own Save handler already applies
    // exactly this rule client-side
    // (`Number.isFinite(parsed) && parsed >= 0`), which is the tell: the
    // constraint was known, it just never made it to the server.
    if (updates.proactive_risk_threshold !== undefined) {
      const parsed = typeof updates.proactive_risk_threshold === 'number'
        ? updates.proactive_risk_threshold
        : parseFloat(String(updates.proactive_risk_threshold))
      if (!Number.isFinite(parsed) || parsed < 0) {
        return NextResponse.json({ error: 'Risk threshold must be a number of 0 or more' }, { status: 400 })
      }
      updates.proactive_risk_threshold = parsed
    }
    // Automatic client reminders: a boolean and two small bounded integers (the columns have matching CHECKs).
    if (updates.auto_client_reminders !== undefined && typeof updates.auto_client_reminders !== 'boolean')
      return NextResponse.json({ error: 'Automatic client reminders must be true or false' }, { status: 400 })
    for (const [col, label, min, max] of [
      ['client_reminder_after_days', 'Days between reminders', 1, 30],
      ['client_reminder_max', 'Maximum reminders', 1, 10],
    ] as const) {
      if (updates[col] === undefined) continue
      const n = typeof updates[col] === 'number' ? (updates[col] as number) : Number(String(updates[col]).trim())
      if (!Number.isInteger(n) || n < min || n > max)
        return NextResponse.json({ error: `${label} must be a whole number from ${min} to ${max}` }, { status: 400 })
      updates[col] = n
    }
    if (updates.proactive_risk_alerts_enabled !== undefined &&
        typeof updates.proactive_risk_alerts_enabled !== 'boolean') {
      return NextResponse.json({ error: 'Risk alerts setting must be true or false' }, { status: 400 })
    }

    // FIX (deep audit, Settings section — missing-column bug): validate
    // against the same three tiers the DB CHECK constraint enforces
    // (035_guardian_sensitivity_tier_column.sql) and GuardianTab's own
    // <select> offers, so a bad value 400s here with a clear message
    // instead of surfacing as an opaque Postgres constraint-violation
    // error from the update below.
    if (typeof updates.guardian_sensitivity_tier === 'string') {
      const SENSITIVITY_TIERS = ['conservative', 'medium', 'aggressive']
      if (!SENSITIVITY_TIERS.includes(updates.guardian_sensitivity_tier)) {
        return NextResponse.json({ error: 'Invalid Guardian sensitivity tier' }, { status: 400 })
      }
    }

    // FIX (Workspace lifecycle + Onboarding, round 4) — corrected in the
    // Settings re-pass: the round-4 fix validated industry/timezone here
    // against onboarding's own curated lists, but this route also serves
    // Settings' Workspace tab, whose Industry field is (by design) free
    // text and whose Timezone <select> is (by design) the full IANA list
    // — both deliberately broader than onboarding's quick-pick UI. Keep
    // currency's check (Settings' own currency <select> is already a
    // strict subset of CURRENCIES, so that one doesn't regress), but
    // validate industry as ordinary free text and timezone against real
    // IANA validity instead of onboarding's narrower curated set.
    if (typeof updates.industry === 'string') {
      const trimmed = updates.industry.trim()
      if (trimmed.length > 100) {
        return NextResponse.json({ error: 'Industry must be under 100 characters' }, { status: 400 })
      }
      updates.industry = trimmed
    }
    if (typeof updates.currency === 'string' && !(CURRENCIES as readonly string[]).includes(updates.currency)) {
      return NextResponse.json({ error: 'Invalid currency' }, { status: 400 })
    }
    if (typeof updates.timezone === 'string' && updates.timezone !== '' && !isValidIanaTimezone(updates.timezone)) {
      return NextResponse.json({ error: 'Invalid timezone' }, { status: 400 })
    }

    // FIX (re-audit, notifications section): same gap as workspace/create
    // — agency_name (and the workspace's own display `name`) flow
    // unescaped-for-headers into email "From" display names and subject
    // lines across ~10 templates, with no length cap or control-character
    // restriction anywhere on the settings-update path either.
    if (typeof updates.agency_name === 'string') updates.agency_name = sanitizeDisplayName(updates.agency_name)
    if (typeof updates.name === 'string')        updates.name        = sanitizeDisplayName(updates.name)

    // FIX (deep audit, Settings section \u2014 HIGH): sanitizeDisplayName('')
    // returns '', and nothing rejected it. Both columns are NOT NULL, but
    // '' satisfies NOT NULL perfectly well \u2014 so `{"name": ""}` was a
    // completely valid save. That is not just cosmetic: DangerTab gates
    // workspace deletion on `confirm !== workspace?.name`, so once the
    // name is '', the empty, untouched confirmation input EQUALS the
    // workspace name and "Delete workspace permanently" is live on page
    // load with no type-to-confirm step at all. An empty agency_name is
    // milder but prints as a blank "From" block on every SOW/CO/Invoice
    // PDF and outbound email.
    for (const col of ['name', 'agency_name'] as const) {
      if (updates[col] !== undefined && !String(updates[col] ?? '').trim()) {
        return NextResponse.json({
          error: col === 'name' ? 'Workspace name is required' : 'Agency name is required',
        }, { status: 400 })
      }
    }

    // FIX (deep audit, section 5 — validation gap): taxId/phone/website/
    // defaultPaymentInstructions had no length cap or type check at all,
    // unlike every other free-text field on this route (industry,
    // agency_name, name). They don't flow into email headers the way
    // agency_name/name do — they only ever render as plain PDF text (see
    // lib/pdf/renderer.tsx's <Text> usage) or auto-escaped JSX on portal
    // pages — so this isn't an injection fix, just closing an
    // unbounded-input gap on columns that are otherwise unguarded.
    const TEXT_FIELD_LIMITS: Record<string, number> = {
      tax_id: 50, phone: 40, website: 200, default_payment_instructions: 2000,
    }
    for (const [col, max] of Object.entries(TEXT_FIELD_LIMITS)) {
      if (typeof updates[col] === 'string') {
        const trimmed = (updates[col] as string).trim()
        if (trimmed.length > max) {
          return NextResponse.json({ error: `${col.replace(/_/g, ' ')} must be under ${max} characters` }, { status: 400 })
        }
        updates[col] = trimmed
      }
    }

    // FEATURE (Notifications & email fix round): Reply-To for client-facing email (SOW, change order,
    // invoice and their reminders). Blank clears it (replies then go to whoever sent the email). Only
    // written when the request includes it, so saves from an older client — or before migration 062
    // adds the column — are unaffected.
    if (body.replyToEmail !== undefined) {
      const v = typeof body.replyToEmail === 'string' ? body.replyToEmail.trim() : ''
      if (v === '') updates.reply_to_email = null
      else if (v.length > 254 || !isDeliverableAddress(v))
        return NextResponse.json({ error: 'Enter a valid reply-to email address' }, { status: 400 })
      else updates.reply_to_email = v
    }

    // legalAddress is a structured object (line1/line2/city/region/postalCode/country),
    // not a flat scalar, so it doesn't fit the fieldMap loop above. Stored as-is in the
    // legal_address jsonb column; the PDF renderer formats it for display.
    //
    // FIX (deep audit, section 5 — validation gap): previously stored
    // whatever shape the client sent with zero validation — not just
    // unbounded length, but no guarantee it was even an object (a string,
    // array, or number would have been accepted and persisted as-is into
    // a jsonb column typed for a structured address). formatAddressLines()
    // (lib/utils/format.ts) already degrades gracefully against a
    // malformed shape, so this was never a crash risk — but it's still an
    // unvalidated write path. Only pick the six known keys, coerce each to
    // a capped, trimmed string, and reject anything that isn't a plain
    // object to begin with.
    if (body.legalAddress !== undefined) {
      if (body.legalAddress === null) {
        updates.legal_address = null
      } else if (typeof body.legalAddress !== 'object' || Array.isArray(body.legalAddress)) {
        return NextResponse.json({ error: 'Invalid legal address' }, { status: 400 })
      } else {
        const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const
        const cleanAddress: Record<string, string> = {}
        for (const key of ADDRESS_FIELDS) {
          const value = (body.legalAddress as Record<string, unknown>)[key]
          if (typeof value !== 'string') continue
          const trimmed = value.trim()
          if (trimmed.length > 200) {
            return NextResponse.json({ error: `Address ${key} must be under 200 characters` }, { status: 400 })
          }
          if (trimmed) cleanAddress[key] = trimmed
        }
        updates.legal_address = cleanAddress
      }
    }

    // Slug is editable exactly once (spec §1.0). The UI now always submits
    // the current slug as part of the whole form, so only treat this as a
    // change attempt (and enforce the lock) if it actually differs from
    // what's stored — otherwise every future save of any other field would
    // 409 once the slug had been set once.
    if (body.slug !== undefined) {
      // Guard the type before .toLowerCase() \u2014 a non-string slug threw a
      // TypeError straight into the catch-all below and surfaced as a 500.
      if (typeof body.slug !== 'string') {
        return NextResponse.json({ error: 'Invalid workspace slug' }, { status: 400 })
      }
      const { data: ws } = await (service as any)
        .from('workspaces').select('slug, slug_changed_at').eq('id', session.workspaceId).single()
      const newSlug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      if (newSlug !== ws?.slug) {
        if (ws?.slug_changed_at) {
          return NextResponse.json({ error: 'Workspace slug can only be changed once' }, { status: 409 })
        }
        // FIX (deep audit, section 5): slug has a UNIQUE constraint
        // (001_initial_schema.sql), but this route never pre-checked for a
        // collision before attempting the update — on a taken slug, the
        // raw Postgres error ("duplicate key value violates unique
        // constraint...") bubbled straight to the UI via the catch-all
        // below. That's a rough thing to see on a field the UI itself
        // warns is a one-time, permanent choice. Check first and give a
        // plain-language answer instead.
        const { count: slugTaken } = await (service as any)
          .from('workspaces').select('id', { count: 'exact', head: true })
          .eq('slug', newSlug).neq('id', session.workspaceId)
        if ((slugTaken || 0) > 0) {
          return NextResponse.json({ error: 'That URL is already taken. Please choose another.' }, { status: 409 })
        }
        updates.slug            = newSlug
        updates.slug_changed_at = new Date().toISOString()
      }
    }

    const { error } = await (service as any)
      .from('workspaces').update(updates).eq('id', session.workspaceId)

    if (error) {
      // Belt-and-suspenders against a race between the pre-check above and
      // this update (two people saving the same brand-new slug at once).
      if ((error as any).code === '23505') {
        return NextResponse.json({ error: 'That URL is already taken. Please choose another.' }, { status: 409 })
      }
      // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
      // used to `throw new Error(error.message)`, which the catch-all
      // below returned to the client verbatim — a raw Postgres error,
      // the exact info-disclosure pattern already fixed for every one of
      // the seven named workspace-lifecycle routes but missed here, even
      // though this route is what onboarding step 0's "go back and
      // re-edit" path calls. Log server-side and return a generic
      // message directly instead.
      console.error('Workspace settings update failed:', error)
      return NextResponse.json({ error: 'Failed to update workspace settings' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.settings_updated', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { fields: Object.keys(body) },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): the
    // write-error branch above is now hardened against this exact leak —
    // the outer catch-all was missed, so an unexpected exception (a
    // malformed body, a network-level Supabase client error) still
    // returned raw internals to the client.
    console.error('Workspace settings error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
