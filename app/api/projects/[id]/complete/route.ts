import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MARK_PROJECT_COMPLETE'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()

    const { data: project } = await (service as any)
      .from('projects')
      .select('id,name,status,change_orders(id,title,status),guardian_flags(id,status)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (project.status !== 'Active')
      return NextResponse.json({ error: 'Only Active projects can be marked complete' }, { status: 400 })

    // Spec §5.3: blocked if any awaiting_response, countered, or stalled COs
    // FIX (doc-completeness audit, migration 014): 'awaiting_countersignature'
    // is just as open/unresolved as these — a project shouldn't be
    // completable while a CO is sitting there waiting on the client's
    // signature on the negotiated amount.
    const blockingCos = (project.change_orders || []).filter((co: any) =>
      ['awaiting_response','countered','stalled','awaiting_countersignature'].includes(co.status)
    )
    if (blockingCos.length > 0) {
      return NextResponse.json({
        error: `${blockingCos.length} change order${blockingCos.length !== 1 ? 's' : ''} must be resolved before marking complete`,
        blockingCos: blockingCos.map((co: any) => ({ id: co.id, title: co.title, status: co.status })),
      }, { status: 409 })
    }

    const now = new Date().toISOString()

    // Auto-close all open flags in same transaction — status='open' ONLY (BUG-051 / spec §5.3 fixed v11)
    const openFlags = (project.guardian_flags || []).filter((f: any) => f.status === 'open')
    if (openFlags.length > 0) {
      await (service as any).from('guardian_flags')
        .update({
          status:      'closed',
          close_reason: `Project marked complete by ${session.name}`,
          resolved_at: now,
          updated_at:  now,
        })
        .in('id', openFlags.map((f: any) => f.id))
    }

    // Mark complete
    await (service as any).from('projects')
      .update({ status: 'Complete', updated_at: now }).eq('id', id)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project.completed', entityType: 'project',
      entityId: id, entityName: project.name,
      metadata: { flags_auto_closed: openFlags.length },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
