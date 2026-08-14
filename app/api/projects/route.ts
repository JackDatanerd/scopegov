import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_PROJECTS' }, { status: 403 })

    const body = await request.json()
    const { clientId, newClient, name, disc, type, contractValue, currency, startDate, internalRef } = body

    if (!name?.trim() || !type)
      return NextResponse.json({ error: 'Name and type are required' }, { status: 400 })

    const service   = createServiceClient()
    let resolvedClientId = clientId

    // ── Create client if new ──────────────────────────────────
    if (!resolvedClientId && newClient?.name && newClient?.email) {
      // Check for duplicate email in this workspace
      const { data: existing } = await (service as any)
        .from('clients')
        .select('id, name')
        .eq('workspace_id', session.workspaceId)
        .eq('email', newClient.email.toLowerCase().trim())
        .single()

      if (existing) {
        resolvedClientId = existing.id
      } else {
        const { data: created, error: clientErr } = await (service as any)
          .from('clients')
          .insert({
            workspace_id: session.workspaceId,
            name:         newClient.name.trim(),
            email:        newClient.email.toLowerCase().trim(),
          })
          .select('id')
          .single()
        if (clientErr) throw new Error(clientErr.message)
        resolvedClientId = created.id
      }
    }

    if (!resolvedClientId)
      return NextResponse.json({ error: 'Client is required' }, { status: 400 })

    // FIX (audit round 4, finding #2 — HIGH): an explicitly-passed
    // clientId (the "pick an existing client" path — the newClient
    // branch above always creates/looks up scoped to this workspace
    // already) was never checked against session.workspaceId before
    // being written into projects.client_id. Exact same bug class
    // already found and fixed for change_orders.project_id (see
    // app/api/co/route.ts, round 3) — a member of Workspace A could
    // point a new project at a client row belonging to Workspace B,
    // leaking that client's name/email/billing address/VAT into A on
    // every subsequent read (PDFs, portal sends, invoices all join
    // projects → clients with no re-check), and potentially emailing an
    // unrelated agency's real client under A's branding.
    if (clientId) {
      const { data: client } = await (service as any)
        .from('clients').select('id').eq('id', clientId).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // ── Create project ────────────────────────────────────────
    const { data: project, error: projErr } = await (service as any)
      .from('projects')
      .insert({
        workspace_id:   session.workspaceId,
        client_id:      resolvedClientId,
        name:           name.trim(),
        disc:           disc?.trim() || null,
        type,
        status:         'Draft',
        contract_value: parseFloat(contractValue) || 0,
        currency:       currency || 'USD',
        start_date:     startDate || null,
        internal_ref:   internalRef?.trim() || null,
        created_by:     session.id,
      })
      .select('id')
      .single()

    if (projErr) throw new Error(projErr.message)

    // Auto-add creator to project_members
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', session.workspaceId)
      .eq('user_id', session.id)
      .single()

    if (member) {
      await (service as any).from('project_members').insert({
        project_id: project.id,
        member_id:  member.id,
        added_by:   session.id,
      })
    }

    // Audit log
    await (service as any).from('audit_log').insert({
      workspace_id: session.workspaceId,
      actor_id:     session.id,
      actor_email:  session.email,
      actor_name:   session.name,
      event_type:   'project.created',
      entity_type:  'project',
      entity_id:    project.id,
      entity_name:  name.trim(),
      metadata:     { type, contract_value: contractValue, currency },
    })

    return NextResponse.json({ projectId: project.id })
  } catch (err) {
    console.error('Project create error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service    = createServiceClient()
    const canViewAll = hasPermission(session, 'VIEW_ALL_PROJECTS')

    let query = (service as any)
      .from('projects')
      .select('id,name,status,type,contract_value,currency,clients(id,name)')
      .eq('workspace_id', session.workspaceId)
      .is('deleted_at', null)
      .order('name')

    if (!canViewAll) {
      // FIX: project_members has neither workspace_id nor user_id columns
      // (it links to workspace_members via member_id, which links to users
      // via user_id) — this query referenced two nonexistent columns, so it
      // always errored and silently resolved to an empty list, meaning
      // anyone with only VIEW_OWN_PROJECTS saw zero projects, always,
      // regardless of actual assignments.
      const { data: ids } = await (service as any)
        .from('project_members')
        .select('project_id, workspace_members!inner(user_id)')
        .eq('workspace_members.user_id', session.id)
      query = query.in('id', (ids || []).map((r: any) => r.project_id))
    }

    const { data: projects } = await query
    return NextResponse.json({ projects: projects || [] })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
