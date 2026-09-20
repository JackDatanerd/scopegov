export const runtime = 'nodejs'

// FEATURE (portal audit, section 18): the invoice portal was the one
// document type with no way for a client to push back at all — SOW gets
// decline + request-changes, CO gets decline + counter, invoice got
// nothing. Deliberately not a status transition (see migration 046's
// comment on why disputed_at/dispute_note are informational columns, not
// a new invoices.status value) — this just records the concern and tells
// the agency, the same "make the silence visible" job every other portal
// action already does.

import { checkedSend } from '@/lib/email/delivery'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { cleanTextField } from '@/lib/utils/sanitize'
import { resolveInvoiceToken } from '@/lib/documents/invoice-token'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { sendInvoiceDisputedEmail, sendClientResponseReceivedEmail } from '@/lib/email/templates'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service = createServiceClient()

    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'invoice.dispute')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'invoice.dispute')

    const body = await request.json().catch(() => ({} as any))
    // Free text from an unauthenticated link holder: type-checked, markup-stripped and capped. (A non-string
    // note used to throw on `.trim()` and surface as a 500.)
    const cleaned = cleanTextField(body?.note, 4000)
    if (cleaned === null) return NextResponse.json({ error: 'note must be text' }, { status: 400 })
    const note = cleaned.trim()
    if (note.length < 10)
      return NextResponse.json({ error: 'Please describe the issue (minimum 10 characters)' }, { status: 400 })

    const resolved = await resolveInvoiceToken(service, token, `id, title, invoice_number, status, workspace_id, project_id, projects(id, name, client_id, clients(name, email, cc_emails), workspaces(agency_name, brand_colour))`)
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    const invoice = resolved.invoice

    const now = new Date().toISOString()
    const project = invoice.projects
    const client  = project?.clients

    // Not a CAS-guarded lifecycle transition — status is untouched, this
    // just stamps when + what. A client can re-flag with an updated note
    // any time; last write wins, same as any other informational field.
    // A fresh dispute re-opens the thread: clear any earlier agency resolution.
    const { error: disputeErr } = await (service as any).from('invoices')
      .update({ disputed_at: now, dispute_note: note, dispute_resolved_at: null, dispute_resolution_note: null, dispute_resolved_by: null })
      .eq('id', invoice.id)
    if (disputeErr) {
      console.error('Invoice dispute: update failed:', disputeErr)
      return NextResponse.json({ error: 'Could not record your message — please try again.' }, { status: 500 })
    }

    await logAudit(service, {
      // FIX (build, Reports & Audit re-pass): actor_id is `uuid REFERENCES
      // users(id)` — a client is never a platform user, so actorId was
      // being set to their display name (not even an email), an invalid
      // uuid that fails silently on insert (supabase-js doesn't throw on
      // a DB error, and this call site's return value was never checked).
      // This event never once reached audit_log. null is correct here,
      // same as every automated call site; actorEmail (fixed to the real
      // client email above) and actorName still carry the identity.
      workspaceId: invoice.workspace_id, actorId: null,
      // FIX (build, cron/portal audit round): this was hardcoded to the
      // placeholder 'portal@client' because the query never selected
      // clients.email — every equivalent client-actioned event elsewhere
      // in the portal (SOW decline/counter, CO decline/counter) logs the
      // real client email. Fall back to the placeholder only in the
      // unexpected case a client record has none, rather than always
      // discarding it.
      actorEmail: client?.email || 'portal@client', actorName: client?.name || 'Client',
      eventType: 'invoice.disputed', entityType: 'invoice',
      entityId: invoice.id, entityName: invoice.title,
      metadata: { note: note },
    })

    await notifyMembersWithPermission(service, {
      workspaceId: invoice.workspace_id, permission: 'VIEW_FINANCIALS', eventType: 'invoice_disputed',
      type: 'invoice_disputed', title: `Invoice question — ${project?.name || invoice.title}`,
      body: `${client?.name || 'The client'}: ${note}`.slice(0, 160),
      entityType: 'project', entityId: project?.id, projectId: project?.id,
    })

    try {
      const emails = await getMemberEmailsWithPermission(service, invoice.workspace_id, 'VIEW_FINANCIALS', 25, 'invoice_disputed', project?.id)
      if (emails.length) {
        await sendInvoiceDisputedEmail({
          to: emails,
          clientName: client?.name || 'Client',
          projectName: project?.name || invoice.title,
          invoiceNumber: invoice.invoice_number,
          note: note,
          projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project?.id}?tab=billing`,
        })
      }
    } catch (e) { console.error('Invoice disputed email failed:', e) }

    // FEATURE (Notifications & email fix round): the client got nothing back
    // after pressing "dispute" — every other client response (SOW decline /
    // change request, CO decline / counter) already sends a receipt.
    if (client?.email) {
      const cc = await withPrimaryContactCc(service, project?.client_id, client.email, client.cc_emails)
      const replyTo = await resolveReplyTo(service, invoice.workspace_id, null)
      await checkedSend(() => sendClientResponseReceivedEmail({
        replyTo,
        to: client.email, cc, clientName: client.name, agencyName: project?.workspaces?.agency_name || '',
        projectName: project?.name || invoice.title, documentLabel: 'Invoice', response: 'disputed',
        note: note.trim().slice(0, 500), brandColour: project?.workspaces?.brand_colour,
      }), 'Invoice disputed (client receipt)')
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice dispute error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
