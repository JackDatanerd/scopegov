import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { parseClientInput } from '@/lib/utils/client-input'
import { fetchPaged } from '@/lib/utils/paginate'
const MAX_CLIENTS_LISTED = 5000

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()
    // FIX (independent pass, section 14): the read error was ignored (an outage rendered as an
    // empty list — "No clients yet" — which invites creating duplicates), and a plain select is
    // silently capped at PostgREST's 1,000 rows, so the tail of a big roster vanished. Paged, with
    // errors surfaced and an explicit `truncated` flag.
    const { rows: clients, truncated } = await fetchPaged<any>((from, to) =>
      (service as any)
        .from('clients')
        .select('id,name,company_name,email,status,created_at,email_bounced_at', { count: 'exact' })
        .eq('workspace_id', session.workspaceId)
        .order('name').order('id')
        .range(from, to),
      { maxRows: MAX_CLIENTS_LISTED })

    // FIX (audit round 4, finding #3): VIEW_CLIENT_DATA was enforced by
    // redacting fields server-side on the client-detail page, but this
    // list route shipped the raw email to every authenticated workspace
    // member regardless of that permission — a plain curl/fetch of this
    // endpoint bypassed the gate entirely. Redact at the source, same
    // fix shape as clients/[id]/page.tsx.
    const canViewClientData = hasPermission(session, 'VIEW_CLIENT_DATA')
    const result = canViewClientData
      ? (clients || [])
      // FIX (independent pass 1, section 14 — B5): the page also withholds email_bounced_at (it says the address
      // is dead — contact-data health); this route returned it to everyone.
      : (clients || []).map((c: any) => ({ ...c, email: null, email_bounced_at: null }))

    // FIX (deep audit, section 14 — bug, traced into Projects): POST here
    // requires CREATE_PROJECTS + VIEW_CLIENT_DATA (see that handler), but
    // nothing told a caller which of those it's missing before it tries.
    // app/(app)/projects/new/page.tsx already fetches this exact response
    // to populate its client picker — surfacing the flag here (the caller
    // this page already makes, not a new endpoint) lets it hide/disable its
    // own "+ New client" entry point instead of letting the same
    // CREATE_PROJECTS-without-VIEW_CLIENT_DATA role fill out a form that
    // was always going to 403.
    const canCreateClient = hasPermission(session, 'CREATE_PROJECTS') && canViewClientData

    return NextResponse.json({ clients: result, canCreateClient, truncated })
  } catch (err) {
    console.error('Clients list error:', err)
    return NextResponse.json({ error: 'Could not load clients' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    // FIX (deep audit, section 14 — flagship finding): PATCH /api/clients/
    // [id] was hardened (audit round 6) to also require VIEW_CLIENT_DATA
    // before writing email/phone/notes/ccEmails — reasoning being that a
    // role shouldn't be trusted to set contact data it isn't allowed to
    // see. This route writes those exact same fields (email is mandatory
    // on every create) but never got the matching gate — a
    // CREATE_PROJECTS-only role could set a brand-new client's email,
    // phone, notes, and cc_emails despite GET already redacting all of
    // them from that same role's view. Close the same hole here.
    if (!hasPermission(session, 'VIEW_CLIENT_DATA'))
      return NextResponse.json({ error: 'Missing permission: VIEW_CLIENT_DATA' }, { status: 403 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    const parsed = parseClientInput(body, 'create')
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const u = parsed.updates as any

    const service = createServiceClient()

    // FIX (independent pass round 4, section 14 — minor finding): the previous version did a
    // separate select-then-insert. The DB's exact-string UNIQUE(workspace_id, email) constraint
    // (001_initial_schema) always closes the exact-match race, but clients_workspace_email_lower
    // (077) — the case-INSENSITIVE guard — is only created when a workspace has no pre-existing
    // case-variant duplicates; for a workspace where it wasn't, two concurrent creates for the same
    // address differing only by case could both slip through this route's own ilike pre-check and
    // both insert. create_client (088) does the duplicate check AND the insert inside one
    // transaction under an advisory lock on (workspace_id, lower(email)), closing that race
    // regardless of whether the lower() index exists for this workspace.
    const { data: result, error } = await (service as any).rpc('create_client', {
      p_workspace_id: session.workspaceId,
      p_name:         u.name,
      p_email:        u.email,
      p_company_name: u.company_name ?? null,
      p_cc_emails:    u.cc_emails ?? [],
      p_phone:        u.phone ?? null,
      p_notes:        u.notes ?? null,
      p_timezone:     u.timezone ?? null,
      p_billing_address: u.billing_address ?? null,
      p_vat_number:      u.vat_number ?? null,
      p_payment_terms_note: u.payment_terms_note ?? null,
    })
    // Belt-and-braces: the DB's own UNIQUE constraint still exists as a last resort (e.g. a schema
    // rollback that predates 088) — surface it the same clean way as the RPC's own dup result.
    if (error?.code === '23505')
      return NextResponse.json({ error: 'A client with this email already exists' }, { status: 409 })
    if (error) throw new Error(error.message)
    if (!result?.ok)
      return NextResponse.json({
        error: 'A client with this email already exists',
        existingClientId: result?.existing_id, existingClientName: result?.existing_name,
      }, { status: 409 })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client.created', entityType: 'client',
      entityId: result.client_id, entityName: u.name, metadata: {},
    })
    return NextResponse.json({ clientId: result.client_id })
  } catch (err) {
    console.error('Client create error:', err)
    return NextResponse.json({ error: 'Could not create the client' }, { status: 500 })
  }
}
