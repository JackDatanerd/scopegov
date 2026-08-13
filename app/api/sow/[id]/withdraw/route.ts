export const runtime = 'nodejs'

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
    if (!hasPermission(session, 'SEND_SOW'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id,status,token,version,project_id,projects(id,name,status)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!['awaiting_signature','changes_requested'].includes(sow.status))
      return NextResponse.json({ error: 'SOW cannot be withdrawn in current status' }, { status: 400 })

    const now = new Date().toISOString()

    // Revoke token
    if (sow.token) {
      await (service as any).from('revoked_tokens').insert({
        token: sow.token, token_type: 'sow', reason: 'withdrawn',
        revoked_by: session.id,
      })
    }

    await (service as any).from('sow_documents')
      .update({ status: 'withdrawn', updated_at: now }).eq('id', id)

    // Revert project to Intake
    await (service as any).from('projects')
      .update({ status: 'Intake', updated_at: now })
      .eq('id', sow.projects?.id)
      .in('status', ['Awaiting Signature','Changes Requested'])

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'sow.withdrawn', entityType: 'sow',
      entityId: id, entityName: sow.projects?.name,
      metadata: { version: sow.version },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
