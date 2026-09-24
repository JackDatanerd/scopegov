export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'

// FEATURE (independent pass, section 14): duplicate clients (the same company entered under two
// email addresses) had no fix — no delete, no merge. This moves every project, saved contact and
// CC address from THIS client (the source) into `targetId`, then removes the source. Runs as one
// database transaction (merge_clients, migration 073). It deletes a client record, so it needs the
// same DELETE_PROJECTS permission the plain delete does, plus the usual client-edit permissions.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: sourceId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS') || !hasPermission(session, 'VIEW_CLIENT_DATA') || !hasPermission(session, 'DELETE_PROJECTS'))
      return NextResponse.json({ error: 'Merging clients needs CREATE_PROJECTS, VIEW_CLIENT_DATA and DELETE_PROJECTS' }, { status: 403 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    const targetId = body?.targetId
    if (typeof targetId !== 'string' || !targetId) return NextResponse.json({ error: 'targetId is required' }, { status: 400 })
    if (targetId === sourceId) return NextResponse.json({ error: 'Choose a different client to merge into.' }, { status: 400 })

    const service = createServiceClient()
    const { data: rows } = await (service as any).from('clients')
      .select('id, name, email').eq('workspace_id', session.workspaceId).in('id', [sourceId, targetId])
    const source = rows?.find((c: any) => c.id === sourceId)
    const target = rows?.find((c: any) => c.id === targetId)
    if (!source || !target) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

    const { data: result, error } = await (service as any).rpc('merge_clients', {
      p_workspace_id: session.workspaceId, p_source: sourceId, p_target: targetId,
    })
    if (error) {
      if (/not_found/.test(error.message)) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      throw new Error(error.message)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client.merged', entityType: 'client', entityId: targetId, entityName: target.name,
      metadata: {
        merged_from: { id: source.id, name: source.name, email: source.email },
        projects_moved: result?.projects_moved ?? null, contacts_moved: result?.contacts_moved ?? null,
      },
    })
    return NextResponse.json({ ok: true, targetId, ...result })
  } catch (err) {
    console.error('Client merge error:', err)
    return NextResponse.json({ error: 'Could not merge the clients' }, { status: 500 })
  }
}
