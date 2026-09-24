// app/api/clients/[id]/contacts/route.ts
//
// FEATURE (deep audit, section 14, finding #8): public.client_contacts has
// existed since 001_initial_schema.sql — id/client_id/name/email/role/
// is_primary, RLS enabled, a unique partial index enforcing one primary
// contact per client, and it's already wired into the workspace-purge
// cascade (migration 020's comment even documents it: "client_contacts
// cascades from clients(id)"). But nothing in the application ever read
// or wrote it — no route, no component, not even lib/supabase/types.ts.
// Every "contact" surface that does exist (ClientContactCard, cc_emails)
// operates on a single flat set of fields on `clients` itself, which
// can't represent "invoices go to billing@client.com, scope questions go
// to the PM, Jane is the primary contact." This is the first read/write
// surface for that table.
//
// Same permission split as clients/[id]/route.ts's contact-visibility
// fields: viewing requires VIEW_CLIENT_DATA, writing requires both that
// and CREATE_PROJECTS (this codebase has no dedicated client-edit
// permission — see that route's comment for why reusing CREATE_PROJECTS
// is the deliberate, documented tradeoff here too).

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_CLIENT_DATA'))
      return NextResponse.json({ error: 'Missing permission: VIEW_CLIENT_DATA' }, { status: 403 })

    const service = createServiceClient()
    const { data: client } = await (service as any)
      .from('clients').select('id')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!client) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { data: contacts } = await (service as any)
      .from('client_contacts')
      .select('id,name,email,role,is_primary,created_at')
      .eq('client_id', id)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true })

    return NextResponse.json({ contacts: contacts || [] })
  } catch (err) {
    console.error('clients/[id]/contacts error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS') || !hasPermission(session, 'VIEW_CLIENT_DATA'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: client } = await (service as any)
      .from('clients').select('id,name')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!client) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await request.json()
    const { name, email, role, isPrimary } = body
    if (!name?.trim() || !email?.trim())
      return NextResponse.json({ error: 'Name and email required' }, { status: 400 })
    if (!EMAIL_RE.test(email.trim()))
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })

    // Supabase JS has no multi-statement transaction here (same
    // limitation noted for create_workspace_atomic() elsewhere in this
    // schema) — unset any existing primary first, then insert. The
    // unique partial index (client_contacts_one_primary) is still the
    // backstop against a genuine race producing two primaries.
    if (isPrimary) {
      await (service as any).from('client_contacts')
        .update({ is_primary: false }).eq('client_id', id).eq('is_primary', true)
    }

    const { data: contact, error } = await (service as any)
      .from('client_contacts').insert({
        client_id:  id,
        name:       name.trim(),
        email:      email.toLowerCase().trim(),
        role:       role?.trim() || null,
        is_primary: !!isPrimary,
      }).select('id,name,email,role,is_primary,created_at').single()

    if (error?.code === '23505')
      return NextResponse.json({ error: 'Only one primary contact is allowed per client' }, { status: 409 })
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client_contact.created', entityType: 'client_contact',
      entityId: contact.id, entityName: `${name.trim()} (${client.name})`, metadata: {},
    })

    return NextResponse.json({ contact })
  } catch (err) {
    console.error('clients/[id]/contacts error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
