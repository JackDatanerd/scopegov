import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { cancelApprovalRequest } from '@/lib/approvals/engine'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // FIX (audit round 3): same gap as close/route.ts — no permission check
    // at all. Any authenticated workspace member could withdraw any CO
    // (killing the client's portal link and cancelling an in-flight
    // approval chain) with none of the permissions every sibling action
    // requires.
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS' }, { status: 403 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select('id,title,status,flag_id,token,projects(name)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!['awaiting_response','draft'].includes(co.status))
      return NextResponse.json({ error: 'Cannot withdraw CO in current status' }, { status: 400 })

    const now = new Date().toISOString()
    await (service as any).from('change_orders')
      .update({ status: 'withdrawn', token: null, updated_at: now }).eq('id', id)

    // Phase 3: a draft CO can have an approval chain in flight (that's the
    // whole point of gating send, not create) — don't leave it dangling
    // for an approver once the CO itself is withdrawn.
    await cancelApprovalRequest(service, {
      documentType: 'co', documentId: id, workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: 'CO withdrawn',
    })

    // Revoke token
    if (co.token) {
      try {
        await (service as any).from('revoked_tokens').insert({
          token: co.token, token_type: 'co', reason: 'withdrawn', revoked_by: session.id,
        })
      } catch (e) { console.error('Token revoke insert failed (non-fatal):', e) }
    }

    // BUG-048: revert linked flag on withdraw
    if (co.flag_id) {
      const { data: flag } = await (service as any)
        .from('guardian_flags').select('id,status').eq('id', co.flag_id).single()
      if (flag?.status === 'converted_to_co') {
        await (service as any).from('guardian_flags').update({
          status: 'open', change_order_id: null, updated_at: now,
        }).eq('id', co.flag_id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name,
          eventType: 'flag.reverted_to_open', entityType: 'guardian_flag',
          entityId: co.flag_id, entityName: co.projects?.name,
          metadata: { co_id: id, reason: 'CO withdrawn' },
        })
      }
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.withdrawn', entityType: 'change_order',
      entityId: id, entityName: co.title, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
