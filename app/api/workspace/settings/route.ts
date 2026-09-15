import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'

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
      throw new Error(error.message)
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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
