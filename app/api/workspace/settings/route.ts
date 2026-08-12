import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

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
        updates.slug            = newSlug
        updates.slug_changed_at = new Date().toISOString()
      }
    }

    const { error } = await (service as any)
      .from('workspaces').update(updates).eq('id', session.workspaceId)

    if (error) throw new Error(error.message)

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
