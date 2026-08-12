// app/api/clients/[id]/route.ts
//
// Phase 11: this route did not exist before — clients could be created
// (POST /api/clients) but never edited afterward, at the API layer or
// anywhere else. That meant billing_address and vat_number, which have
// existed as columns since 001_initial_schema.sql, were permanently
// unreachable once a client record was created (and unreachable at
// creation time too, until this same change added them to the POST body).
//
// Reuses CREATE_PROJECTS, same as the POST route — there is no dedicated
// client-edit permission in the schema (see lib/supabase/types.ts) and
// inventing one here would need seeding into every existing role, which
// is out of scope for a billing-fields fix.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()

    const { data: existing } = await (service as any)
      .from('clients').select('id,name')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body    = await request.json()
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

    const fieldMap: Record<string, string> = {
      name:              'name',
      companyName:       'company_name',
      phone:             'phone',
      timezone:          'timezone',
      notes:             'notes',
      paymentTermsNote:  'payment_terms_note',
      vatNumber:         'vat_number',
    }
    for (const [key, col] of Object.entries(fieldMap)) {
      if (body[key] !== undefined) updates[col] = typeof body[key] === 'string' ? body[key].trim() || null : body[key]
    }

    // billingAddress is a structured object ({ line1, line2, city, region,
    // postalCode, country }), stored as-is in the billing_address jsonb
    // column — this is what makes it show up as the "Bill To" address on
    // Invoice/SOW/CO PDFs (see lib/pdf/renderer.tsx).
    if (body.billingAddress !== undefined) {
      updates.billing_address = body.billingAddress
    }

    // Email changes go through the same duplicate check as creation.
    if (body.email !== undefined && body.email.trim()) {
      const newEmail = body.email.toLowerCase().trim()
      const { data: dupe } = await (service as any)
        .from('clients').select('id').eq('workspace_id', session.workspaceId)
        .eq('email', newEmail).neq('id', id).single()
      if (dupe) return NextResponse.json({ error: 'A client with this email already exists' }, { status: 409 })
      updates.email = newEmail
    }

    const { error } = await (service as any)
      .from('clients').update(updates).eq('id', id).eq('workspace_id', session.workspaceId)
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'client.updated', entityType: 'client',
      entityId: id, entityName: existing.name, metadata: { fields: Object.keys(body) },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
