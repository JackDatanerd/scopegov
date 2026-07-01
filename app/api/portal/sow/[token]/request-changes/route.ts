export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const { note }  = await request.json()

    if (!note || note.trim().length < 20)
      return NextResponse.json({ error: 'Please describe the changes needed (minimum 20 characters)' }, { status: 400 })

    const service = createServiceClient()

    const { data: revoked } = await (service as any)
      .from('revoked_tokens').select('id').eq('token', token).single()
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id,version,status,sections,metadata,project_id,workspace_id,projects(id,name,disc,workspaces(jwt_secret,agency_name),clients(name,email))')
      .eq('token', token).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (sow.status !== 'awaiting_signature')
      return NextResponse.json({ error: 'SOW is not awaiting signature' }, { status: 409 })

    try {
      const secret = new TextEncoder().encode(sow.projects.workspaces.jwt_secret)
      await jwtVerify(token, secret)
    } catch {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })
    }

    const now     = new Date().toISOString()
    const project = sow.projects
    const client  = project.clients

    // Mark current version as changes_requested
    await (service as any).from('sow_documents').update({
      status: 'changes_requested', updated_at: now,
    }).eq('id', sow.id)

    // Create new draft version (same transaction per spec §1.3)
    const { data: newSow } = await (service as any).from('sow_documents').insert({
      project_id:          project.id,
      workspace_id:        sow.workspace_id,
      version:             sow.version + 1,
      status:              'draft',
      sections:            sow.sections,
      metadata:            sow.metadata,
      previous_version_id: sow.id,
    }).select('id').single()

    // Update project status to Changes Requested
    await (service as any).from('projects').update({
      status: 'Changes Requested', updated_at: now,
    }).eq('id', project.id)

    await logAudit(service, {
      workspaceId: sow.workspace_id, actorId: client.email,
      actorEmail: client.email, actorName: client.name,
      eventType: 'sow.changes_requested', entityType: 'sow',
      entityId: sow.id, entityName: project.name,
      metadata: { note, new_version: sow.version + 1, new_sow_id: newSow?.id },
    })

    // Notify agency members with SEND_SOW permission (Event 6)
    try {
      const emails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW')
      if (emails.length) {
        const { Resend } = await import('resend')
        const resend = new Resend(process.env.RESEND_API_KEY)
        await resend.emails.send({
          from: `${project.workspaces.agency_name} via ScopeGov <${process.env.RESEND_FROM_EMAIL}>`,
          to: emails,
          subject: `${client.name} requested changes on the ${project.name} SOW`,
          html: `<p><strong>${client.name}</strong> has requested changes on the <strong>${project.name}</strong> SOW (v${sow.version}).</p>
          <p><strong>Feedback:</strong> ${note}</p>
          <p>A new draft (v${sow.version + 1}) has been created in ScopeGov for you to edit and resend.</p>
          <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=sow">Open project in ScopeGov →</a></p>`,
        })
      }
    } catch (e) { console.error('Changes requested email failed:', e) }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
