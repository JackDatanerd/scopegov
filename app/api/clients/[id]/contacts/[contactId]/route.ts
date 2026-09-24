// app/api/clients/[id]/contacts/[contactId]/route.ts
//
// See app/api/clients/[id]/contacts/route.ts for the full context on why
// this surface didn't exist until now (deep audit, section 14, finding #8).

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { EMAIL_RE, CLIENT_LIMITS, CONTACT_ROLE_TYPES } from '@/lib/utils/client-input'

const escapeLike = (v: string) => v.replace(/[\\%_]/g, m => `\${m}`)

async function loadContact(service: any, workspaceId: string, clientId: string, contactId: string) {
  const { data: client } = await service
    .from('clients').select('id,name')
    .eq('id', clientId).eq('workspace_id', workspaceId).single()
  if (!client) return { client: null, contact: null }

  const { data: contact } = await service
    .from('client_contacts').select('id,name,email,role,role_type,is_primary')
    .eq('id', contactId).eq('client_id', clientId).single()
  return { client, contact }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  try {
    const { id, contactId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS') || !hasPermission(session, 'VIEW_CLIENT_DATA'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { client, contact } = await loadContact(service, session.workspaceId, id, contactId)
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
      if (body.name.trim().length > CLIENT_LIMITS.name) return NextResponse.json({ error: `Name is too long (${CLIENT_LIMITS.name} characters max)` }, { status: 400 })
      patch.name = body.name.trim()
    }
    if (body.email !== undefined) {
      const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : ''
      if (email.length > CLIENT_LIMITS.email || !EMAIL_RE.test(email))
        return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })
      if (email !== String(contact.email).toLowerCase()) {
        const { data: dupe } = await (service as any).from('client_contacts')
          .select('id,name').eq('client_id', id).ilike('email', escapeLike(email)).neq('id', contactId).limit(1).maybeSingle()
        if (dupe) return NextResponse.json({ error: `${dupe.name} already has this email address.` }, { status: 409 })
      }
      patch.email = email
    }
    if (body.role !== undefined) {
      if (body.role !== null && typeof body.role !== 'string') return NextResponse.json({ error: 'Role must be text' }, { status: 400 })
      patch.role = typeof body.role === 'string' ? body.role.trim().slice(0, 100) || null : null
    }
    if (body.roleType !== undefined) {
      if (!CONTACT_ROLE_TYPES.includes(body.roleType))
        return NextResponse.json({ error: `roleType must be one of: ${CONTACT_ROLE_TYPES.join(', ')}` }, { status: 400 })
      patch.role_type = body.roleType
    }
    if (body.isPrimary !== undefined) {
      if (typeof body.isPrimary !== 'boolean') return NextResponse.json({ error: 'isPrimary must be true or false' }, { status: 400 })
      patch.is_primary = body.isPrimary
    }

    // Only what actually changed is written and audited.
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const [k, v] of Object.entries(patch)) {
      if ((contact as any)[k] !== v) changes[k] = { from: (contact as any)[k] ?? null, to: v }
    }
    if (Object.keys(changes).length === 0) return NextResponse.json({ ok: true, unchanged: true })
    const effective: Record<string, unknown> = {}
    for (const k of Object.keys(changes)) effective[k] = patch[k]

    // Primary swap + field update in ONE transaction (see client_contact_update, migration 077) —
    // the old code demoted the current primary first and updated second, so a failure in between
    // left the client with no primary contact.
    const { data: found, error } = await (service as any).rpc('client_contact_update', {
      p_client_id: id, p_contact_id: contactId, p_patch: effective,
    })
    if (error?.code === '23505')
      return NextResponse.json({
        error: /email/i.test(error.message) ? 'A contact with this email already exists for this client.' : 'Only one primary contact is allowed per client',
      }, { status: 409 })
    if (error) throw new Error(error.message)
    if (!found) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client_contact.updated', entityType: 'client_contact',
      entityId: contactId, entityName: `${(patch.name as string) || contact.name} (${client.name})`,
      metadata: { fields: Object.keys(changes), changes },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('clients/[id]/contacts/[contactId] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  try {
    const { id, contactId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS') || !hasPermission(session, 'VIEW_CLIENT_DATA'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { client, contact } = await loadContact(service, session.workspaceId, id, contactId)
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    const { error } = await (service as any)
      .from('client_contacts').delete().eq('id', contactId).eq('client_id', id)
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client_contact.deleted', entityType: 'client_contact',
      entityId: contactId, entityName: `${contact.name} (${client.name})`,
      metadata: { email: contact.email, role: contact.role, role_type: contact.role_type, was_primary: contact.is_primary },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('clients/[id]/contacts/[contactId] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
