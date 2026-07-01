import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

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
        note:         note || null,
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
