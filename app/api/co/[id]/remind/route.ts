export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { Resend } from 'resend'

// FIX (re-audit — build-blocking): module-scope instantiation, same class
// as lib/email/templates.ts / lib/ai/guardian.ts — lazy singleton instead.
let _resend: Resend | null = null
function resendClient(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

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
      .select(`id, title, status, token, total, project_id,
        projects(id, name, currency,
          clients(name, email, cc_emails),
          workspaces(agency_name, brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    // FIX (doc-completeness audit, migration 014): a CO waiting on the
    // client to countersign the negotiated total is just as reminder-able
    // as one still awaiting their initial response.
    // FIX (re-audit, cron/portal section): 'stalled' used to be excluded
    // here entirely — once co-stall's cron auto-stalled a CO, this route
    // rejected with 400 and the CO detail page hid the Remind button (see
    // components/projects/ProjectDetail.tsx), leaving Close or Escalate as
    // the only actions. There was no way back to "still trying to reach
    // the client" short of an internal escalation. Allowing a remind from
    // 'stalled' — and un-stalling the CO back to 'awaiting_response' with
    // a fresh sent_at below — gives the agency an actual "try again" path
    // instead of a dead end.
    if (!['awaiting_response', 'awaiting_countersignature', 'stalled'].includes(co.status))
      return NextResponse.json({ error: 'Can only remind on COs awaiting a client response' }, { status: 400 })

    const isCountersign = co.status === 'awaiting_countersignature'
    const wasStalled     = co.status === 'stalled'

    if (wasStalled) {
      await (service as any).from('change_orders').update({
        status: 'awaiting_response', sent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', id).eq('status', 'stalled')
    }

    const project   = co.projects
    const client    = project?.clients
    const ws        = project?.workspaces
    const accent    = ws?.brand_colour || '#1A5C3A'
    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/co/${co.token}`
    const currency  = project?.currency || 'USD'

    await resendClient().emails.send({
      from:    `${ws?.agency_name} via ScopeGov <${process.env.RESEND_FROM_EMAIL}>`,
      to:      client?.email,
      cc:      client?.cc_emails?.filter(Boolean) || [],
      subject: isCountersign
        ? `Reminder: Please confirm your change order — ${co.title}`
        : `Reminder: Change order awaiting your response — ${co.title}`,
      html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#F2F0EA;margin:0;padding:40px 20px;">
      <div style="max-width:580px;margin:0 auto;background:#FFF;border:1px solid #E5E1D8;border-radius:8px;overflow:hidden;">
        <div style="background:${accent};padding:22px 28px;">
          <div style="font-size:11px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Reminder — Change order</div>
          <div style="font-family:Georgia,serif;font-size:20px;color:#FFF;">${co.title}</div>
        </div>
        <div style="padding:28px;">
          <p style="font-size:14px;color:#333;line-height:1.7;margin:0 0 16px;">Hi ${client?.name},</p>
          <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">
            ${isCountersign
              ? `The agency has accepted your proposed amount for <strong>${project?.name}</strong> and it's ready for you to confirm.`
              : `A change order for <strong>${project?.name}</strong> is awaiting your response.`}
            Total: <strong>${currency} ${(co.total || 0).toLocaleString()}</strong>
          </p>
          <a href="${portalUrl}" style="display:inline-block;background:${accent};color:#FFF;padding:12px 24px;border-radius:5px;font-size:13px;font-weight:600;text-decoration:none;">
            ${isCountersign ? 'Review &amp; Confirm →' : 'Review &amp; Respond →'}
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
      metadata: { type: 'co', client_email: client?.email, was_stalled: wasStalled },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
