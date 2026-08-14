import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

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

    const body    = await request.json()
    const { name, companyName, email, phone, notes, timezone, billingAddress, vatNumber } = body
    if (!name?.trim() || !email?.trim())
      return NextResponse.json({ error: 'Name and email required' }, { status: 400 })

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

    if (error) throw new Error(error.message)
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'client.created', entityType: 'client',
      entityId: client.id, entityName: name.trim(), metadata: {},
    })
    return NextResponse.json({ clientId: client.id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
