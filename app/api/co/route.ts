import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'
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

    // FIX (re-audit): flagId came straight from the request body with no
    // check that it actually belongs to this project/workspace. Every
    // downstream CO lifecycle action that touches a linked flag — close,
    // withdraw, accept-counter, and the client portal's accept/decline/
    // counter handlers — later fetches and updates guardian_flags by this
    // raw id with no workspace_id filter of its own (they trust the CO's
    // flag_id implicitly). Left unvalidated here, a member could set
    // flagId to a UUID belonging to a DIFFERENT workspace's flag, and a
    // later action on this CO would silently mutate that foreign flag's
    // status — a cross-tenant write via the service-role client, which
    // bypasses RLS entirely. Same rule as roleId in team/invite/route.ts:
    // confirm the referenced row is actually ours before it ever reaches
    // the insert.
    let validatedFlagId: string | null = null
    if (flagId) {
      const { data: flag } = await (service as any)
        .from('guardian_flags').select('id')
        .eq('id', flagId).eq('project_id', projectId).eq('workspace_id', session.workspaceId)
        .maybeSingle()
      if (!flag) return NextResponse.json({ error: 'Flag not found on this project' }, { status: 400 })
      validatedFlagId = flag.id
    }

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
        flag_id:      validatedFlagId,
        title:        title.trim(),
        note:         sanitizeRichTextOrNull(note),
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
