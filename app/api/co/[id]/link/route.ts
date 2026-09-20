export const runtime = 'nodejs'

// GET /api/co/[id]/link
//
// Returns the client-portal response link for a change order that is with the client, so the agency can
// copy it and send it by hand (chat, another mail account) when the email did not arrive or was
// rejected by the mail provider — a failure that is otherwise invisible. The token is a
// credential (anyone holding it can accept, counter or decline as the client), so this is limited to members who could
// send the change order in the first place and is never included in the general CO GET response.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { logAudit } from '@/lib/utils/audit'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS' }, { status: 403 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select('id, status, token, expires_at, version, project_id, title, projects(name)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!['awaiting_response', 'stalled', 'awaiting_countersignature'].includes(co.status) || !co.token)
      return NextResponse.json({ error: 'There is no active response link for this change order.' }, { status: 400 })
    if (co.expires_at && new Date(co.expires_at) <= new Date())
      return NextResponse.json({ error: 'This response link has expired.' }, { status: 410 })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'co.link_viewed', entityType: 'change_order', entityId: id, entityName: co.title,
      metadata: { version: co.version },
    })

    const base = process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL
    return NextResponse.json({ portalUrl: `${base}/portal/co/${co.token}`, expiresAt: co.expires_at })
  } catch (err) {
    console.error('CO link error:', err)
    return NextResponse.json({ error: 'Could not load the response link.' }, { status: 500 })
  }
}
