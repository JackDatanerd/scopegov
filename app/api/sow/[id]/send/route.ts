export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { sendSowEmail } from '@/lib/email/templates'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_SOW'))
      return NextResponse.json({ error: 'Missing permission: SEND_SOW' }, { status: 403 })

    // Email must be verified to send (spec §16.0)
    if (!session.emailVerifiedAt)
      return NextResponse.json({ error: 'Please verify your email before sending SOWs' }, { status: 403 })

    const service = createServiceClient()

    // Fetch SOW + project + client + workspace
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, status, project_id,
        projects(id, name, disc, contract_value, currency, client_id,
          clients(name, email, cc_emails),
          workspaces(id, agency_name, brand_colour, logo_storage_path, jwt_secret))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    if (sow.status !== 'draft')
      return NextResponse.json({ error: 'Only draft SOWs can be sent' }, { status: 400 })

    const project   = sow.projects
    const client    = project?.clients
    const workspace = project?.workspaces

    if (!client?.email)
      return NextResponse.json({ error: 'Client email is required to send SOW' }, { status: 400 })

    // Issue document JWT — HS256 with workspace-specific secret (spec §0.4)
    const secret    = new TextEncoder().encode(workspace.jwt_secret)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    const token     = await new SignJWT({
      sowId:       id,
      workspaceId: session.workspaceId,
      projectId:   project.id,
      clientEmail: client.email,
      action:      'sign',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(expiresAt)
      .setJti(nanoid())
      .sign(secret)

    const now = new Date().toISOString()

    // Update SOW: draft → awaiting_signature. Note: 'sent' is NOT a status (spec §1.3)
    await (service as any).from('sow_documents').update({
      status:     'awaiting_signature',
      sent_at:    now,
      token,
      expires_at: expiresAt.toISOString(),
      updated_at: now,
    }).eq('id', id)

    // Update project status
    await (service as any).from('projects').update({
      status:     'Awaiting Signature',
      updated_at: now,
    }).eq('id', project.id)

    // Send email (awaited — carry-forward §4.4)
    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/sow/${token}`
    try {
      await sendSowEmail({
        to:           client.email,
        cc:           client.cc_emails || [],
        clientName:   client.name,
        agencyName:   workspace.agency_name,
        projectName:  project.name + (project.disc ? ` — ${project.disc}` : ''),
        contractValue: project.contract_value,
        currency:     project.currency,
        portalUrl,
        brandColour:  workspace.brand_colour,
        expiresAt:    expiresAt.toISOString(),
      })
    } catch (emailErr) {
      console.error('SOW send email failed:', emailErr)
      // Email failure is non-fatal for the operation — SOW is still sent
    }

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'sow.sent', entityType: 'sow',
      entityId: id, entityName: project.name,
      metadata: { version: sow.version, client_email: client.email },
    })

    return NextResponse.json({ ok: true, token, portalUrl })
  } catch (err) {
    console.error('SOW send error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
