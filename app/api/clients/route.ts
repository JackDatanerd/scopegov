import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()
    const { data: clients } = await (service as any)
      .from('clients')
      .select('id,name,company_name,email,status,created_at')
      .eq('workspace_id', session.workspaceId)
      .order('name')

    // FIX (audit round 4, finding #3): VIEW_CLIENT_DATA was enforced by
    // redacting fields server-side on the client-detail page, but this
    // list route shipped the raw email to every authenticated workspace
    // member regardless of that permission — a plain curl/fetch of this
    // endpoint bypassed the gate entirely. Redact at the source, same
    // fix shape as clients/[id]/page.tsx.
    const canViewClientData = hasPermission(session, 'VIEW_CLIENT_DATA')
    const result = canViewClientData
      ? (clients || [])
      : (clients || []).map((c: any) => ({ ...c, email: null }))

    return NextResponse.json({ clients: result })
  } catch { return NextResponse.json({ error: 'Error' }, { status: 500 }) }
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

    const body    = await request.json()
    const { name, companyName, email, phone, notes, timezone, billingAddress, vatNumber, ccEmails } = body
    if (!name?.trim() || !email?.trim())
      return NextResponse.json({ error: 'Name and email required' }, { status: 400 })
    // FIX (audit round 6): only presence was checked, not shape — an
    // unvalidated address here is what every invoice/SOW/CO for this
    // client actually gets sent to, so a typo means silent, permanent
    // delivery failure with no error at creation time.
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!EMAIL_RE.test(email.trim()))
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })

    // FIX (audit round 6): cc_emails is read by every document-send route
    // (invoice/SOW/CO send, remind, void, withdraw, portal accept) but had
    // no create/edit path anywhere — every client's cc_emails was
    // permanently stuck at '{}'. Accept it here (and in PATCH) same as any
    // other contact field: comma/newline-separated string or array, each
    // entry validated and lowercased like the primary email.
    let normalizedCcEmails: string[] = []
    if (ccEmails) {
      const raw = Array.isArray(ccEmails) ? ccEmails : String(ccEmails).split(/[,\n]/)
      normalizedCcEmails = raw.map((e: string) => e.trim().toLowerCase()).filter(Boolean)
      const invalid = normalizedCcEmails.find(e => !EMAIL_RE.test(e))
      if (invalid)
        return NextResponse.json({ error: `Invalid CC email address: ${invalid}` }, { status: 400 })
    }

    const service = createServiceClient()

    // Duplicate email check
    const { data: existing } = await (service as any)
      .from('clients').select('id,name').eq('workspace_id', session.workspaceId)
      .eq('email', email.toLowerCase().trim()).single()
    if (existing)
      return NextResponse.json({ error: 'A client with this email already exists', existingClientId: existing.id }, { status: 409 })

    const { data: client, error } = await (service as any)
      .from('clients').insert({
        workspace_id: session.workspaceId,
        name:         name.trim(),
        company_name: companyName?.trim() || null,
        email:        email.toLowerCase().trim(),
        cc_emails:    normalizedCcEmails,
        phone:        phone?.trim() || null,
        notes:        notes?.trim() || null,
        timezone:     timezone || null,
        // Phase 11: billing_address/vat_number existed in the schema since
        // 001_initial_schema.sql but were never reachable from this route —
        // every client created before now has them NULL, which is fine, the
        // PDF renderer treats them as optional and just omits the block.
        billing_address: billingAddress || null,
        vat_number:      vatNumber?.trim() || null,
      }).select('id').single()

    // FIX (audit round 6): the manual dupe-check above has a TOCTOU window
    // that's actually closed by the DB's own UNIQUE(workspace_id, email)
    // constraint — good — but a race that slips through it surfaced as a
    // raw Postgres constraint-violation message via the generic catch
    // below instead of the same clean 409 the pre-check was written to
    // produce. Catch that one specific case explicitly.
    if (error?.code === '23505')
      return NextResponse.json({ error: 'A client with this email already exists' }, { status: 409 })
    if (error) throw new Error(error.message)
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client.created', entityType: 'client',
      entityId: client.id, entityName: name.trim(), metadata: {},
    })
    return NextResponse.json({ clientId: client.id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
