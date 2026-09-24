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
import { EMAIL_RE, CLIENT_LIMITS, CONTACT_ROLE_TYPES, type ContactRoleType } from '@/lib/utils/client-input'

const MAX_CONTACTS_PER_CLIENT = 25
const escapeLike = (v: string) => v.replace(/[\\%_]/g, m => `\${m}`)
const CONTACT_COLS = 'id,name,email,role,role_type,is_primary,created_at'

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

    const { data: contacts, error } = await (service as any)
      .from('client_contacts')
      .select(CONTACT_COLS)
      .eq('client_id', id)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)

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

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    // FIX (independent pass, section 14): fields were never type-checked (a non-string name threw a
    // TypeError → 500), and nothing capped lengths, the number of contacts, or repeated emails.
    if (typeof body?.name !== 'string' || !body.name.trim() || typeof body?.email !== 'string' || !body.email.trim())
      return NextResponse.json({ error: 'Name and email required' }, { status: 400 })
    const name  = body.name.trim()
    const email = body.email.trim().toLowerCase()
    if (name.length > CLIENT_LIMITS.name) return NextResponse.json({ error: `Name is too long (${CLIENT_LIMITS.name} characters max)` }, { status: 400 })
    if (email.length > CLIENT_LIMITS.email || !EMAIL_RE.test(email))
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })
    if (body.role !== undefined && body.role !== null && typeof body.role !== 'string')
      return NextResponse.json({ error: 'Role must be text' }, { status: 400 })
    const role = typeof body.role === 'string' ? body.role.trim().slice(0, 100) || null : null
    const roleType: ContactRoleType = body.roleType === undefined ? 'other' : body.roleType
    if (!CONTACT_ROLE_TYPES.includes(roleType))
      return NextResponse.json({ error: `roleType must be one of: ${CONTACT_ROLE_TYPES.join(', ')}` }, { status: 400 })

    const { count } = await (service as any).from('client_contacts')
      .select('id', { count: 'exact', head: true }).eq('client_id', id)
    if ((count || 0) >= MAX_CONTACTS_PER_CLIENT)
      return NextResponse.json({ error: `A client can have at most ${MAX_CONTACTS_PER_CLIENT} contacts.` }, { status: 409 })

    const { data: dupe } = await (service as any).from('client_contacts')
      .select('id,name').eq('client_id', id).ilike('email', escapeLike(email)).limit(1).maybeSingle()
    if (dupe) return NextResponse.json({ error: `${dupe.name} already has this email address.` }, { status: 409 })

    // FIX (independent pass, section 14): the old primary was demoted in one statement and the new
    // contact inserted in another — a failure in between left the client with NO primary contact.
    // client_contact_add (migration 077) does both in a single transaction under a row lock.
    const { data: newId, error } = await (service as any).rpc('client_contact_add', {
      p_client_id: id, p_name: name, p_email: email, p_role: role, p_role_type: roleType, p_is_primary: body.isPrimary === true,
    })
    if (error?.code === '23505') {
      return NextResponse.json({
        error: /email/i.test(error.message) ? 'A contact with this email already exists for this client.' : 'Only one primary contact is allowed per client',
      }, { status: 409 })
    }
    if (error) throw new Error(error.message)

    const { data: contact } = await (service as any).from('client_contacts').select(CONTACT_COLS).eq('id', newId).single()

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client_contact.created', entityType: 'client_contact',
      entityId: newId, entityName: `${name} (${client.name})`,
      metadata: { email, role, role_type: roleType, is_primary: body.isPrimary === true },
    })

    return NextResponse.json({ contact })
  } catch (err) {
    console.error('clients/[id]/contacts error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
