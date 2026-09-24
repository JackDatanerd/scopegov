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
import { parseClientInput } from '@/lib/utils/client-input'

// ilike treats % and _ as wildcards — an email like jo_hn@x.com must match literally.
const escapeLike = (v: string) => v.replace(/[\\%_]/g, m => `\${m}`)

// Free-text fields whose VALUE is not copied into the audit trail (only "changed").
const AUDIT_REDACT = new Set(['notes'])

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()

    const { data: existing } = await (service as any)
      .from('clients').select('*')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    // (audit round 6) Contact-visibility fields require VIEW_CLIENT_DATA as well — a role that can't SEE
    // a client's email must not be able to blindly overwrite the address every invoice/SOW/CO goes to.
    const contactFields = ['email', 'phone', 'notes', 'paymentTermsNote', 'ccEmails']
    if (contactFields.some(f => body[f] !== undefined) && !hasPermission(session, 'VIEW_CLIENT_DATA')) {
      return NextResponse.json({ error: 'Missing permission: VIEW_CLIENT_DATA' }, { status: 403 })
    }

    // Shared, type-checked parser (see lib/utils/client-input.ts) — replaces the per-route field
    // handling that let non-strings 500, blanked NOT NULL columns and stored arbitrary JSON.
    const parsed = parseClientInput(body, 'update', { currentEmail: existing.email })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const updates: Record<string, unknown> = { ...parsed.updates, updated_at: new Date().toISOString() }

    // status (active/archived)
    if (body.status !== undefined) {
      if (!['active', 'archived'].includes(body.status))
        return NextResponse.json({ error: 'status must be "active" or "archived"' }, { status: 400 })
      updates.status = body.status
    }

    // Email changes go through the same duplicate check as creation (case-insensitive).
    const emailChanged = typeof updates.email === 'string' && updates.email !== String(existing.email || '').toLowerCase()
    if (emailChanged) {
      const { data: dupe } = await (service as any)
        .from('clients').select('id').eq('workspace_id', session.workspaceId)
        .ilike('email', escapeLike(updates.email as string)).neq('id', id).limit(1).maybeSingle()
      if (dupe) return NextResponse.json({ error: 'A client with this email already exists', existingClientId: dupe.id }, { status: 409 })

      // The new primary must not also sit in the CC list, and a corrected address gets a clean
      // delivery-health slate (the bounce marker belonged to the OLD address).
      if (updates.cc_emails === undefined && Array.isArray(existing.cc_emails)) {
        const filtered = existing.cc_emails.filter((e: string) => String(e).toLowerCase() !== updates.email)
        if (filtered.length !== existing.cc_emails.length) updates.cc_emails = filtered
      }
      updates.email_bounced_at = null
      updates.email_bounce_kind = null
    }

    const { error } = await (service as any)
      .from('clients').update(updates).eq('id', id).eq('workspace_id', session.workspaceId)
    if (error?.code === '23505')
      return NextResponse.json({ error: 'A client with this email already exists' }, { status: 409 })
    if (error) throw new Error(error.message)

    // FIX (independent pass, section 14): the audit row recorded only Object.keys(body) — which
    // fields were SENT, not what changed (and it listed a field as updated even when the route
    // ignored it). A change to the email / CC list / billing address redirects where every invoice
    // goes, and nothing recorded the old value. Now: real before → after for what changed.
    const changes: Record<string, { from?: unknown; to?: unknown; changed?: true }> = {}
    for (const [col, next] of Object.entries(updates)) {
      if (col === 'updated_at' || col === 'email_bounced_at' || col === 'email_bounce_kind') continue
      const prev = existing[col]
      if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) continue
      changes[col] = AUDIT_REDACT.has(col) ? { changed: true } : { from: prev ?? null, to: next ?? null }
    }
    if (Object.keys(changes).length > 0) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
        eventType: 'client.updated', entityType: 'client',
        entityId: id, entityName: (updates.name as string) || existing.name,
        metadata: { fields: Object.keys(changes), changes },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Client update error:', err)
    return NextResponse.json({ error: 'Could not update the client' }, { status: 500 })
  }
}

// FEATURE (independent pass, section 14): a client created by mistake (a typo, a duplicate) could
// never be removed — only archived, and it stayed on the roster forever. A client with NO projects
// can now be deleted outright. projects.client_id has no cascade, so a client that has (or ever had,
// including soft-deleted) projects is refused — archive or merge it instead.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'DELETE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: DELETE_PROJECTS' }, { status: 403 })

    const service = createServiceClient()
    const { data: client } = await (service as any)
      .from('clients').select('id, name, email, company_name')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!client) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { count: projectCount, error: countErr } = await (service as any)
      .from('projects').select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId).eq('client_id', id)
    if (countErr) throw new Error(countErr.message)
    if ((projectCount || 0) > 0)
      return NextResponse.json({
        error: `${client.name} has ${projectCount} project${projectCount === 1 ? '' : 's'} on record (including deleted ones), so it can't be deleted. Archive it, or merge it into another client.`,
      }, { status: 409 })

    const { error } = await (service as any).from('clients').delete().eq('id', id).eq('workspace_id', session.workspaceId)
    if (error?.code === '23503')
      return NextResponse.json({ error: 'This client is still referenced by other records and can’t be deleted. Archive it instead.' }, { status: 409 })
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client.deleted', entityType: 'client',
      entityId: id, entityName: client.name,
      metadata: { email: client.email, company_name: client.company_name },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Client delete error:', err)
    return NextResponse.json({ error: 'Could not delete the client' }, { status: 500 })
  }
}
