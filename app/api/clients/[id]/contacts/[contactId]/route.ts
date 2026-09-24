// app/api/clients/[id]/contacts/[contactId]/route.ts
//
// See app/api/clients/[id]/contacts/route.ts for the full context on why
// this surface didn't exist until now (deep audit, section 14, finding #8).

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function loadContact(service: any, workspaceId: string, clientId: string, contactId: string) {
  const { data: client } = await service
    .from('clients').select('id,name')
    .eq('id', clientId).eq('workspace_id', workspaceId).single()
  if (!client) return { client: null, contact: null }

  const { data: contact } = await service
    .from('client_contacts').select('id,name,email,role,is_primary')
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

    const body = await request.json()
    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) {
      if (!body.name.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
      updates.name = body.name.trim()
    }
    if (body.email !== undefined) {
      const email = String(body.email).toLowerCase().trim()
      if (!EMAIL_RE.test(email)) return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })
      updates.email = email
    }
    if (body.role !== undefined) updates.role = body.role?.trim() || null

    if (body.isPrimary !== undefined) {
      if (body.isPrimary) {
        await (service as any).from('client_contacts')
          .update({ is_primary: false }).eq('client_id', id).eq('is_primary', true).neq('id', contactId)
      }
      updates.is_primary = !!body.isPrimary
    }

    const { error } = await (service as any)
      .from('client_contacts').update(updates).eq('id', contactId).eq('client_id', id)
    if (error?.code === '23505')
      return NextResponse.json({ error: 'Only one primary contact is allowed per client' }, { status: 409 })
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client_contact.updated', entityType: 'client_contact',
      entityId: contactId, entityName: `${(updates.name as string) || contact.name} (${client.name})`,
      metadata: { fields: Object.keys(body) },
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
      entityId: contactId, entityName: `${contact.name} (${client.name})`, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('clients/[id]/contacts/[contactId] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
