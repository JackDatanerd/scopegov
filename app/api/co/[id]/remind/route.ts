export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select(`id, title, status, token, total,
        projects(id, name, currency,
          clients(name, email, cc_emails),
          workspaces(agency_name, brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (co.status !== 'awaiting_response')
      return NextResponse.json({ error: 'Can only remind on awaiting_response COs' }, { status: 400 })

    const project   = co.projects
    const client    = project?.clients
    const ws        = project?.workspaces
    const accent    = ws?.brand_colour || '#1A5C3A'
    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/co/${co.token}`
    const currency  = project?.currency || 'USD'

    await resend.emails.send({
      from:    `${ws?.agency_name} via ScopeGov <${process.env.RESEND_FROM_EMAIL}>`,
      to:      client?.email,
      cc:      client?.cc_emails?.filter(Boolean) || [],
      subject: `Reminder: Change order awaiting your response — ${co.title}`,
      html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#F2F0EA;margin:0;padding:40px 20px;">
      <div style="max-width:580px;margin:0 auto;background:#FFF;border:1px solid #E5E1D8;border-radius:8px;overflow:hidden;">
        <div style="background:${accent};padding:22px 28px;">
          <div style="font-size:11px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Reminder — Change order</div>
          <div style="font-family:Georgia,serif;font-size:20px;color:#FFF;">${co.title}</div>
        </div>
        <div style="padding:28px;">
          <p style="font-size:14px;color:#333;line-height:1.7;margin:0 0 16px;">Hi ${client?.name},</p>
          <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">
            A change order for <strong>${project?.name}</strong> is awaiting your response.
            Total: <strong>${currency} ${(co.total || 0).toLocaleString()}</strong>
          </p>
          <a href="${portalUrl}" style="display:inline-block;background:${accent};color:#FFF;padding:12px 24px;border-radius:5px;font-size:13px;font-weight:600;text-decoration:none;">
            Review &amp; Respond →
          </a>
        </div>
      </div>
      <p style="text-align:center;font-size:11px;color:#B0B0B0;margin-top:20px;">
        <a href="https://scopegov.app" style="color:#1A5C3A;">ScopeGov</a>
      </p>
      </body></html>`,
    })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'reminder.sent', entityType: 'change_order',
      entityId: id, entityName: co.title,
      metadata: { type: 'co', client_email: client?.email },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
