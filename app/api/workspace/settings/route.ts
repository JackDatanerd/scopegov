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
    if (typeof updates.sow_language === 'string') {
      const SUPPORTED_SOW_LANGUAGES = ['en', 'es', 'fr', 'pt', 'de', 'sw']
      if (!SUPPORTED_SOW_LANGUAGES.includes(updates.sow_language)) {
        return NextResponse.json({ error: 'Unsupported SOW language' }, { status: 400 })
      }
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

    // legalAddress is a structured object (line1/line2/city/region/postalCode/country),
    // not a flat scalar, so it doesn't fit the fieldMap loop above. Stored as-is in the
    // legal_address jsonb column; the PDF renderer formats it for display.
    if (body.legalAddress !== undefined) {
      updates.legal_address = body.legalAddress
    }

    // Slug is editable exactly once (spec §1.0). The UI now always submits
    // the current slug as part of the whole form, so only treat this as a
    // change attempt (and enforce the lock) if it actually differs from
    // what's stored — otherwise every future save of any other field would
    // 409 once the slug had been set once.
    if (body.slug !== undefined) {
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
