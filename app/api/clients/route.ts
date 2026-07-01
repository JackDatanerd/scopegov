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
    return NextResponse.json({ clients: clients || [] })
  } catch { return NextResponse.json({ error: 'Error' }, { status: 500 }) }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body    = await request.json()
    const { name, companyName, email, phone, notes, timezone } = body
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
