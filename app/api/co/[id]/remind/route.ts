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
import { formatMoney } from '@/lib/utils/money'
import { sendEmail } from '@/lib/email/send'
import { formatFrom } from '@/lib/email/from'
import { resolveReplyTo } from '@/lib/email/reply-to'

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
      .select(`id, title, status, token, total, counter_amount, expires_at, project_id,
        projects(id, name, currency, client_id,
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
    // FIX (section-10 audit, 10-B7): api/sow/[id]/remind explicitly
    // guards `if (!sow.token)`; this never did, so a CO whose send failed
    // part-way would build a portal URL ending in "/null" and email it.
    if (!co.token)
      return NextResponse.json({ error: 'No portal link found — resend the change order' }, { status: 400 })
    // Same expiry gap the SOW reminder had (9-G3): don't email a dead link.
    if (co.expires_at && new Date(co.expires_at) <= new Date())
      return NextResponse.json({
        error: 'This change order\'s link has expired. Revise and resend it to give the client a fresh link.',
      }, { status: 400 })

    // FIX (re-audit): no cooldown existed at all — an agency user could
    // spam this button and spam the client's inbox with no rate limit.
    const cooldown = await checkReminderCooldown(service, 'change_order', id)
    if (!cooldown.allowed) return NextResponse.json({ error: cooldown.message }, { status: 429 })

    const isCountersign = co.status === 'awaiting_countersignature'
    const wasStalled     = co.status === 'stalled'
    const project   = co.projects
    const client    = project?.clients
    const ws        = project?.workspaces
    const accent    = ws?.brand_colour || '#1A5C3A'
    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/co/${co.token}`
    const currency  = project?.currency || 'USD'

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
      eventType: 'reminder.sent', entityType: 'change_order',
      entityId: id, entityName: co.title,
      metadata: { type: 'co', client_email: client?.email, was_stalled: wasStalled },
    })

    // FIX (re-audit, notifications section): this route built its own
    // inline HTML instead of going through lib/email/templates.ts, and
    // was missed by the escapeHtml pass applied everywhere else in that
    // file (and in every other ad-hoc portal email) — co.title,
    // client.name and project.name went into the HTML body raw. Any of
    // those set to markup (no special privilege needed — just
    // SEND_CHANGE_ORDERS / CO creation) would render live in a real
    // client's inbox. Subject line intentionally stays on the raw values
    // (plain text, not HTML — same convention as templates.ts).
    // FIX (section-10 audit, 10-B8): this used a bare `toLocaleString()`
    // with no decimal control, unlike formatCurrency everywhere else — and
    // for an awaiting_countersignature CO it quoted the ORIGINAL total
    // rather than the negotiated one the client is being asked to confirm.
    // (acceptCoCounter rewrites `total` to the negotiated figure, so
    // `total` is right there — but fall back to counter_amount defensively
    // for any row written before that rescale landed.)
    const reminderTotal = isCountersign
      ? (co.total ?? co.counter_amount ?? 0)
      : (co.total ?? 0)

    const titleHtml   = escapeHtml(co.title)
    const clientHtml  = escapeHtml(client?.name)
    const projectHtml = escapeHtml(project?.name)

    if (!client?.email)
      return NextResponse.json({ error: 'This client has no email address on file.' }, { status: 400 })
    const cc = await withPrimaryContactCc(service, project?.client_id, client.email, client.cc_emails)

    // resend.emails.send() resolves with { error } on API failures instead of throwing. The cooldown
    // claim above is recorded BEFORE sending; a failed send logs 'reminder.failed', which
    // checkReminderCooldown treats as "nothing went out", so the agency is not locked out for 24h.
    // FIX (Notifications & email fix round): sent through lib/email/send so the From
    // header is a valid quoted name with the RESEND_FROM_EMAIL fallback (this inline string
    // produced "<undefined>" when the env var was unset), and with a Reply-To.
    const replyTo = await resolveReplyTo(service, session.workspaceId, session.email)
    const delivery = await checkedSend(() => sendEmail({
      from:    formatFrom(ws?.agency_name),
      replyTo,
      to:      client.email,
      cc,
      subject: isCountersign
        ? `Reminder: Please confirm your change order — ${co.title}`
        : `Reminder: Change order awaiting your response — ${co.title}`,
      html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#F2F0EA;margin:0;padding:40px 20px;">
      <div style="max-width:580px;margin:0 auto;background:#FFF;border:1px solid #E5E1D8;border-radius:8px;overflow:hidden;">
        <div style="background:${accent};padding:22px 28px;">
          <div style="font-size:11px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Reminder — Change order</div>
          <div style="font-family:Georgia,serif;font-size:20px;color:#FFF;">${titleHtml}</div>
        </div>
        <div style="padding:28px;">
          <p style="font-size:14px;color:#333;line-height:1.7;margin:0 0 16px;">Hi ${clientHtml},</p>
          <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">
            ${isCountersign
              ? `The agency has accepted your proposed amount for <strong>${projectHtml}</strong> and it's ready for you to confirm.`
              : `A change order for <strong>${projectHtml}</strong> is awaiting your response.`}
            Total: <strong>${escapeHtml(formatMoney(reminderTotal, currency))}</strong>
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
    }, { workspaceId: session.workspaceId, kind: 'co.reminder', entityType: 'change_order', entityId: id, projectId: project?.id, actorId: session.id }), 'CO reminder')

    if (!delivery.ok) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'reminder.failed', entityType: 'change_order',
        entityId: id, entityName: co.title,
        metadata: { type: 'co', error: delivery.error },
      })
      return NextResponse.json({
        error: 'The reminder email could not be delivered. You can copy the response link and send it yourself.',
        detail: delivery.error,
      }, { status: 502 })
    }

    if (wasStalled) {
      await (service as any).from('change_orders').update({
        status: 'awaiting_response', sent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', id).eq('status', 'stalled')
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('CO remind error:', err)
    return NextResponse.json({ error: 'Could not send the reminder. Please try again.' }, { status: 500 })
  }
}
