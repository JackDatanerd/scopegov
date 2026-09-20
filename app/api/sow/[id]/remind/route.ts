export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { checkReminderCooldown } from '@/lib/utils/reminder-cooldown'
import { escapeHtml } from '@/lib/utils/sanitize'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { checkedSend } from '@/lib/email/delivery'
import { sendEmail } from '@/lib/email/send'
import { formatFrom } from '@/lib/email/from'
import { resolveReplyTo } from '@/lib/email/reply-to'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_SOW'))
      return NextResponse.json({ error: 'Missing permission: SEND_SOW' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, token, status, expires_at, project_id,
        projects(id, name, disc, client_id,
          clients(name, email, cc_emails),
          workspaces(agency_name, brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (sow.status !== 'awaiting_signature')
      return NextResponse.json({ error: 'Can only remind on SOWs awaiting signature' }, { status: 400 })
    if (!sow.token)
      return NextResponse.json({ error: 'No portal link found — resend the SOW' }, { status: 400 })
    // FIX (section-9 audit, 9-G3): nothing here ever looked at expires_at.
    // The signing JWT is issued with a 30-day expiry and the portal
    // rejects it after that, but no cron ever flipped the SOW's own
    // status to 'expired' (see app/api/cron/sow-expiry), so a long-stale
    // SOW sat at 'awaiting_signature' indefinitely and this route would
    // cheerfully email the client a dead link — with the body text
    // helpfully announcing an expiry date already in the past.
    if (sow.expires_at && new Date(sow.expires_at) <= new Date())
      return NextResponse.json({
        error: 'This signing link has expired. Start a new version to send the client a fresh link.',
      }, { status: 400 })

    // FIX (re-audit): no cooldown existed at all — an agency user could
    // spam this button and spam the client's inbox with no rate limit.
    const cooldown = await checkReminderCooldown(service, 'sow', id)
    if (!cooldown.allowed) return NextResponse.json({ error: cooldown.message }, { status: 429 })

    const project   = sow.projects
    const client    = project?.clients
    const ws        = project?.workspaces
    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/sow/${sow.token}`
    const accent    = ws?.brand_colour || '#1A5C3A'

    // FIX (re-audit, notifications section): checkReminderCooldown reads
    // the audit log, then the caller acts — a check-then-act race, not an
    // atomic claim. Two near-simultaneous requests (double-click, two
    // tabs) could both pass the check above before either wrote the
    // audit_log row the check relies on, producing two client-facing
    // emails. Writing the audit row here, immediately after the check and
    // before the network call to Resend, doesn't make this atomic (that
    // would need a DB-level constraint), but shrinks the race window from
    // "cooldown check + full email round-trip" down to "cooldown check +
    // one local insert" — good enough given how narrow the trigger already
    // is (rapid double-click on the same button).
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'reminder.sent', entityType: 'sow',
      entityId: id, entityName: project?.name,
      metadata: { type: 'sow', version: sow.version, client_email: client?.email },
    })

    // FIX (re-audit, notifications section): same gap as co/[id]/remind —
    // this route's inline HTML wasn't covered by the escapeHtml pass
    // applied to lib/email/templates.ts and every other ad-hoc portal
    // email. client.name, project.name and agency_name went into the HTML
    // body raw. Subject line intentionally keeps the raw value (plain
    // text, not HTML — same convention as templates.ts).
    const clientHtml  = escapeHtml(client?.name)
    const projectHtml = escapeHtml(project?.name)
    const agencyHtml  = escapeHtml(ws?.agency_name)

    if (!client?.email)
      return NextResponse.json({ error: 'This client has no email address on file.' }, { status: 400 })
    const cc = await withPrimaryContactCc(service, project?.client_id, client.email, client.cc_emails)

    // resend.emails.send() RESOLVES with { error } on API failures instead of throwing — so this
    // used to report success (and burn the 24h cooldown) for reminders that never left.
    // FIX (Notifications & email fix round): sent through lib/email/send so the From
    // header is a valid quoted name with the RESEND_FROM_EMAIL fallback (this inline string
    // produced "<undefined>" when the env var was unset), and with a Reply-To.
    const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
    const delivery = await checkedSend(() => sendEmail({
      from:    formatFrom(ws?.agency_name),
      replyTo,
      to:      client.email,
      cc,
      subject: `Reminder: Please review and sign the ${project?.name} agreement`,
      html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#F2F0EA;margin:0;padding:40px 20px;">
      <div style="max-width:580px;margin:0 auto;background:#FFF;border:1px solid #E5E1D8;border-radius:8px;overflow:hidden;">
        <div style="background:${accent};padding:22px 28px;">
          <div style="font-size:11px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Reminder</div>
          <div style="font-family:Georgia,serif;font-size:20px;color:#FFF;font-weight:400;">
            Your agreement is waiting to be signed
          </div>
        </div>
        <div style="padding:28px;">
          <p style="font-size:14px;color:#333;line-height:1.7;margin:0 0 16px;">Hi ${clientHtml},</p>
          <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">
            This is a friendly reminder that your Statement of Work for
            <strong>${projectHtml}</strong> with <strong>${agencyHtml}</strong>
            is still awaiting your signature.
          </p>
          <p style="font-size:12px;color:#909090;margin:0 0 20px;">
            ${sow.expires_at ? `This link expires ${new Date(sow.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.` : ''}
          </p>
          <a href="${portalUrl}" style="display:inline-block;background:${accent};color:#FFF;padding:12px 24px;border-radius:5px;font-size:13px;font-weight:600;text-decoration:none;">
            Review &amp; Sign Agreement →
          </a>
        </div>
      </div>
      <p style="text-align:center;font-size:11px;color:#B0B0B0;margin-top:20px;">
        Scope governance by <a href="https://scopegov.app" style="color:#1A5C3A;">ScopeGov</a>
      </p>
      </body></html>`,
    }, { workspaceId: session.workspaceId, kind: 'sow.reminder', entityType: 'sow', entityId: id, projectId: project?.id, actorId: session.id }), 'SOW reminder')

    if (!delivery.ok) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'reminder.failed', entityType: 'sow',
        entityId: id, entityName: project?.name,
        metadata: { type: 'sow', version: sow.version, error: delivery.error },
      })
      return NextResponse.json({
        error: 'The reminder email could not be delivered. You can copy the signing link and send it yourself.',
        detail: delivery.error,
      }, { status: 502 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('SOW remind error:', err)
    return NextResponse.json({ error: 'Could not send the reminder. Please try again.' }, { status: 500 })
  }
}
