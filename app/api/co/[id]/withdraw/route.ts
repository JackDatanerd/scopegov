import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

    // Revoke token
    if (co.token) {
      await (service as any).from('revoked_tokens').insert({
        token: co.token, token_type: 'co', reason: 'withdrawn', revoked_by: session.id,
      }).catch(() => {})
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
