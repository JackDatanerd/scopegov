export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { sendDocumentCancelledEmail } from '@/lib/email/templates'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_SOW'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const reason: string | undefined = body?.reason?.trim()

    const service = createServiceClient()
    // FIX (doc-completeness audit): added client/workspace so we can
    // notify the client that the link/SOW they may already have is dead.
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id,status,token,version,project_id,
        projects(id,name,status,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
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

    // FIX (section-9 audit, 9-G2 follow-on): clear the token on the row
    // too, matching app/api/co/[id]/withdraw/route.ts. The revoked_tokens
    // insert above is what actually invalidates it, but leaving the raw
    // JWT sitting on a dead row is needless exposure — and every read
    // path that checks `if (sow.token)` was making decisions off a token
    // that no longer works.
    await (service as any).from('sow_documents')
      .update({ status: 'withdrawn', token: null, updated_at: now }).eq('id', id)

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

    // FIX (doc-completeness audit): 'awaiting_signature' / 'changes_requested'
    // are only reachable after the SOW was actually sent to the client, so
    // if we got here they have a live link/email — tell them it's dead.
    const client = sow.projects?.clients
    if (client?.email) {
      try {
        await sendDocumentCancelledEmail({
          to: client.email, cc: client.cc_emails || [],
          clientName: client.name, agencyName: sow.projects?.workspaces?.agency_name,
          projectName: sow.projects?.name, documentLabel: 'Statement of Work',
          documentTitle: `${sow.projects?.name} — SOW v${sow.version}`,
          action: 'withdrawn', reason: reason || null,
          brandColour: sow.projects?.workspaces?.brand_colour,
        })
      } catch (e) { console.error('SOW withdrawn client email failed:', e) }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
