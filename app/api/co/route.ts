import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sanitizePlainText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body    = await request.json()
    const { projectId, title, note, lineItems, taxRate, taxInclusive, flagId } = body
    if (!projectId || !title)
      return NextResponse.json({ error: 'projectId and title required' }, { status: 400 })

    const service = createServiceClient()

    // FIX (audit round 3): projectId was never verified against the
    // caller's workspace before being written into change_orders.project_id
    // — only workspace_id on the new row itself was set to the caller's
    // own workspace. change_orders.project_id has an FK to projects(id)
    // with no cross-check that project.workspace_id matches, so a member
    // of Workspace A could create a CO whose workspace_id is Workspace A
    // but whose project_id points at a project in Workspace B — corrupting
    // that foreign project's CO list and leaking its name/currency into
    // Workspace A via the join on every subsequent read. Also enforces
    // the same per-project visibility rule as everywhere else: a
    // VIEW_OWN_PROJECTS-only holder of CREATE_CHANGE_ORDERS shouldn't be
    // able to create a CO against a project they're not assigned to.
    const { data: project } = await (service as any)
      .from('projects').select('id').eq('id', projectId).eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const items   = lineItems || []
    const subtotal = items.reduce((s: number, l: any) => s + (l.quantity * l.rate), 0)
    const total    = taxInclusive
      ? subtotal
      : subtotal * (1 + (parseFloat(taxRate) || 0) / 100)

    const { data: co, error: coErr } = await (service as any)
      .from('change_orders')
      .insert({
        project_id:   projectId,
        workspace_id: session.workspaceId,
        flag_id:      flagId || null,
        title:        title.trim(),
        note:         note ? sanitizePlainText(note) || null : null,
        status:       'draft',
        line_items:   JSON.stringify(items),
        subtotal,
        tax_rate:     parseFloat(taxRate) || 0,
        tax_inclusive: taxInclusive || false,
        total,
        created_by:   session.id,
      })
      .select('id').single()

    if (coErr) throw new Error(coErr.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.created', entityType: 'change_order',
      entityId: co.id, entityName: title,
      metadata: { project_id: projectId, total },
    })

    return NextResponse.json({ coId: co.id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
