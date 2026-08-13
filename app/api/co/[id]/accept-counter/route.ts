import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select('id,title,status,flag_id,counter_amount,counter_note,line_items,project_id,workspace_id,projects(id,name,currency)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (co.status !== 'countered')
      return NextResponse.json({ error: 'CO is not in countered status' }, { status: 400 })

    const now = new Date().toISOString()

    // BUG-047: acceptedAt unconditionally populated — including counter-accepted path
    // BUG-047 spec: "counterAcceptedAt retained for audit; queries use acceptedAt alone"
    await (service as any).from('change_orders').update({
      status:              'accepted',
      accepted_at:         now,        // unconditional — always set on all acceptance paths
      accepted_by:         session.name,
      counter_accepted_at: now,
      counter_accepted_by: session.name,
      responded_at:        now,
      total:               co.counter_amount || co.total,
      updated_at:          now,
    }).eq('id', id)

    // BUG-052: highest-versioned signed SOW
    const { data: signedSow } = await (service as any)
      .from('sow_documents')
      .select('id')
      .eq('project_id', co.project_id)
      .eq('status', 'signed')
      .order('version', { ascending: false })
      .limit(1).single()

    if (signedSow) {
      const lineItems    = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])
      const deliverables = lineItems.map((l: any) => l.description).filter(Boolean)

      await (service as any).from('amendments').insert({
        project_id:          co.project_id,
        workspace_id:        co.workspace_id,
        change_order_id:     id,
        signed_sow_id:       signedSow.id,
        title:               `Amendment — ${co.title} (counter accepted)`,
        added_deliverables:  deliverables,
        removed_deliverables: [],
        financial_impact:    co.counter_amount || co.total,
        effective_at:        now,
        pdf_path:            '',
      })

      // Update scope snapshot
      const { data: snap } = await (service as any)
        .from('project_scope_snapshot').select('id,deliverables').eq('project_id', co.project_id).single()
      if (snap && deliverables.length) {
        await (service as any).from('project_scope_snapshot').update({
          deliverables:    [...(snap.deliverables || []), ...deliverables.map((d: string) => ({ title: d }))],
          last_updated_at: now, last_updated_by: 'amendment',
        }).eq('project_id', co.project_id)
      }
    }

    // Resolve linked flag
    if (co.flag_id) {
      await (service as any).from('guardian_flags').update({
        status: 'resolved', resolution: 'change_order', resolved_at: now, updated_at: now,
      }).eq('id', co.flag_id)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.counter_accepted', entityType: 'change_order',
      entityId: id, entityName: co.title,
      metadata: { counter_amount: co.counter_amount, accepted_by: session.name },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
