import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

// Shared handler for terminal non-accepted CO states: close, withdraw, decline
// Spec §6.2: ALL THREE revert linked flag to 'open'. NOT just decline.
async function handleTerminalCoState(
  id: string, newStatus: 'closed' | 'withdrawn' | 'declined',
  session: any, service: any, body: any
) {
  const { data: co } = await (service as any)
    .from('change_orders')
    .select('id,title,status,flag_id,token,projects(id,name)')
    .eq('id', id).eq('workspace_id', session.workspaceId).single()

  if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })

  const TERMINAL_FROM: Record<string, string[]> = {
    closed:    ['draft','awaiting_response','declined','countered','stalled'],
    withdrawn: ['awaiting_response','draft'],
    declined:  ['awaiting_response'],
  }
  if (!TERMINAL_FROM[newStatus].includes(co.status))
    return NextResponse.json({ error: `Cannot ${newStatus} a CO with status ${co.status}` }, { status: 400 })

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { status: newStatus, updated_at: now }

  if (newStatus === 'closed')    updates.close_reason  = body.reason || null
  if (newStatus === 'withdrawn') updates.token          = null
  if (newStatus === 'declined') {
    updates.declined_at     = now
    updates.declined_reason = body.reason || null
  }

  await (service as any).from('change_orders').update(updates).eq('id', id)

  // BUG-048, spec §6.2: flag reversion fires on decline, close, AND withdraw
  // Does NOT fire on stalled or countered (not terminal)
  if (co.flag_id) {
    const { data: flag } = await (service as any)
      .from('guardian_flags').select('id,status').eq('id', co.flag_id).single()

    if (flag && flag.status === 'converted_to_co') {
      await (service as any).from('guardian_flags').update({
        status:          'open',
        change_order_id: null,
        updated_at:      now,
      }).eq('id', co.flag_id)

      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'flag.reverted_to_open', entityType: 'guardian_flag',
        entityId: co.flag_id, entityName: co.projects?.name,
        metadata: { co_id: id, co_status: newStatus, reason: 'CO reached terminal non-accepted state' },
      })
    }
  }

  // Revoke token if present (withdrawn)
  if (newStatus === 'withdrawn' && co.token) {
    try {
      await (service as any).from('revoked_tokens').insert({
        token: co.token, token_type: 'co', reason: 'withdrawn',
        revoked_by: session.id,
      })
    } catch (e) { console.error('Token revoke insert failed (non-fatal):', e) }
  }

  await logAudit(service, {
    workspaceId: session.workspaceId, actorId: session.id,
    actorEmail: session.email, actorName: session.name,
    eventType: `co.${newStatus}`, entityType: 'change_order',
    entityId: id, entityName: co.title,
    metadata: { reason: body.reason, from_status: co.status },
  })

  return NextResponse.json({ ok: true })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // FIX (audit round 3): this route had no permission check at all — every
    // other CO-mutating action (send, remind, escalate, accept-counter,
    // create, PATCH) requires SEND_CHANGE_ORDERS or CREATE_CHANGE_ORDERS, but
    // close() only checked that a session existed. Any authenticated
    // workspace member, regardless of role, could close any CO in the
    // workspace and trigger the linked flag-reversion side effect.
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS' }, { status: 403 })
    const body    = await request.json().catch(() => ({}))
    const service = createServiceClient()
    return handleTerminalCoState(id, 'closed', session, service, body)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
