export const runtime = 'nodejs'

// GET /api/sow/[id]/link
//
// Returns the client-portal signing link for a SOW that is out for signature, so the agency can
// copy it and send it by hand (chat, another mail account) when the email did not arrive or was
// rejected by the mail provider — a failure that is otherwise invisible. The token is a
// credential (anyone holding it can sign as the client), so this is limited to members who could
// send the SOW in the first place and is never included in the general SOW GET response.

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
    if (!hasPermission(session, 'SEND_SOW'))
      return NextResponse.json({ error: 'Missing permission: SEND_SOW' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id, status, token, expires_at, version, project_id, projects(name)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (sow.status !== 'awaiting_signature' || !sow.token)
      return NextResponse.json({ error: 'There is no active signing link for this SOW.' }, { status: 400 })
    if (sow.expires_at && new Date(sow.expires_at) <= new Date())
      return NextResponse.json({ error: 'This signing link has expired.' }, { status: 410 })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'sow.link_viewed', entityType: 'sow', entityId: id, entityName: sow.projects?.name,
      metadata: { version: sow.version },
    })

    const base = process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL
    return NextResponse.json({ portalUrl: `${base}/portal/sow/${sow.token}`, expiresAt: sow.expires_at })
  } catch (err) {
    console.error('SOW link error:', err)
    return NextResponse.json({ error: 'Could not load the signing link.' }, { status: 500 })
  }
}
