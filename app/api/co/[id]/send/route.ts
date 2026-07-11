export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendCoEmail } from '@/lib/email/templates'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS' }, { status: 403 })
    if (!session.emailVerifiedAt)
      return NextResponse.json({ error: 'Please verify your email before sending change orders' }, { status: 403 })

    const service = createServiceClient()

    const { data: co, error: coFetchErr } = await (service as any)
      .from('change_orders')
      .select(`id,title,status,note,total,currency,version,
        projects(id,name,currency,client_id,
          clients(name,email,cc_emails),
          workspaces(id,agency_name,brand_colour,jwt_secret))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) {
      console.error('CO send: lookup failed', { id, workspaceId: session.workspaceId, error: coFetchErr })
      return NextResponse.json({ error: 'CO not found' }, { status: 404 })
    }
    if (co.status !== 'draft')
      return NextResponse.json({ error: 'Only draft COs can be sent' }, { status: 400 })

    const project   = co.projects
    const client    = project?.clients
    const workspace = project?.workspaces

    if (!client?.email)
      return NextResponse.json({ error: 'Client email required' }, { status: 400 })

    const secret     = new TextEncoder().encode(workspace.jwt_secret)
    const expiresAt  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const token      = await new SignJWT({
      coId:        id,
      workspaceId: session.workspaceId,
      projectId:   project.id,
      clientEmail: client.email,
      action:      'respond',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(expiresAt)
      .setJti(nanoid())
      .sign(secret)

    const now = new Date().toISOString()
    await (service as any).from('change_orders').update({
      status:     'awaiting_response',
      sent_at:    now,
      token,
      expires_at: expiresAt.toISOString(),
      updated_at: now,
    }).eq('id', id)

    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/co/${token}`
    try {
      await sendCoEmail({
        to:          client.email,
        cc:          client.cc_emails || [],
        clientName:  client.name,
        agencyName:  workspace.agency_name,
        projectName: project.name,
        coTitle:     co.title,
        total:       co.total,
        currency:    project.currency || 'USD',
        portalUrl,
        brandColour: workspace.brand_colour,
        note:        co.note,
      })
    } catch (e) { console.error('CO email failed:', e) }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.sent', entityType: 'change_order',
      entityId: id, entityName: co.title, metadata: { total: co.total },
    })

    return NextResponse.json({ ok: true, token, portalUrl })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
