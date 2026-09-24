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
import { getClientIp } from '@/lib/utils/request-ip'

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

    // FIX (audit round 6): every field this route can write — including
    // email, phone, notes, and cc_emails — was gated only by CREATE_PROJECTS,
    // the same permission that gates the billing fields (a documented,
    // deliberate tradeoff for those). But GET/page reads redact exactly
    // those contact fields behind VIEW_CLIENT_DATA. That meant a role with
    // CREATE_PROJECTS but not VIEW_CLIENT_DATA could blindly overwrite a
    // client's email — the address every invoice/SOW/CO actually gets sent
    // to — despite never being allowed to see what it currently was.
    // Require VIEW_CLIENT_DATA too whenever the payload touches a
    // contact-visibility field; billing-only edits (billingAddress,
    // vatNumber, name, companyName, timezone) keep the original
    // CREATE_PROJECTS-only behavior.
    const contactFields = ['email', 'phone', 'notes', 'paymentTermsNote', 'ccEmails']
    if (contactFields.some(f => body[f] !== undefined) && !hasPermission(session, 'VIEW_CLIENT_DATA')) {
      return NextResponse.json({ error: 'Missing permission: VIEW_CLIENT_DATA' }, { status: 403 })
    }

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

    // FIX (audit round 6): status (active/archived) has existed as a
    // column with a CHECK constraint since the initial schema, but nothing
    // anywhere ever wrote it — a client could never be archived, and the
    // client list had no way to hide ones an agency no longer works with.
    if (body.status !== undefined) {
      if (!['active', 'archived'].includes(body.status))
        return NextResponse.json({ error: 'status must be "active" or "archived"' }, { status: 400 })
      updates.status = body.status
    }

    // billingAddress is a structured object ({ line1, line2, city, region,
    // postalCode, country }), stored as-is in the billing_address jsonb
    // column — this is what makes it show up as the "Bill To" address on
    // Invoice/SOW/CO PDFs (see lib/pdf/renderer.tsx).
    if (body.billingAddress !== undefined) {
      updates.billing_address = body.billingAddress
    }

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

    // FIX (audit round 6): cc_emails was never editable anywhere despite
    // being read by every document-send route — see api/clients/route.ts
    // POST for the fuller explanation. Same validation here.
    if (body.ccEmails !== undefined) {
      const raw = Array.isArray(body.ccEmails) ? body.ccEmails : String(body.ccEmails || '').split(/[,\n]/)
      const normalized = raw.map((e: string) => e.trim().toLowerCase()).filter(Boolean)
      const invalid = normalized.find((e: string) => !EMAIL_RE.test(e))
      if (invalid) return NextResponse.json({ error: `Invalid CC email address: ${invalid}` }, { status: 400 })
      updates.cc_emails = normalized
    }

    // Email changes go through the same duplicate check as creation.
    if (body.email !== undefined && body.email.trim()) {
      const newEmail = body.email.toLowerCase().trim()
      // FIX (audit round 6): format was never validated, only presence —
      // see api/clients/route.ts POST for why that matters here.
      if (!EMAIL_RE.test(newEmail))
        return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })
      const { data: dupe } = await (service as any)
        .from('clients').select('id').eq('workspace_id', session.workspaceId)
        .eq('email', newEmail).neq('id', id).single()
      if (dupe) return NextResponse.json({ error: 'A client with this email already exists' }, { status: 409 })
      updates.email = newEmail
    }

    const { error } = await (service as any)
      .from('clients').update(updates).eq('id', id).eq('workspace_id', session.workspaceId)
    // FIX (audit round 6): close the same TOCTOU-race error-shape gap as
    // the POST route — see its comment for the full reasoning.
    if (error?.code === '23505')
      return NextResponse.json({ error: 'A client with this email already exists' }, { status: 409 })
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client.updated', entityType: 'client',
      entityId: id, entityName: existing.name, metadata: { fields: Object.keys(body) },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('clients/[id] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
