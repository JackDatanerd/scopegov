export const runtime = 'nodejs'

// FEATURE (portal audit, section 18): the invoice portal was the one
// document type with no way for a client to push back at all — SOW gets
// decline + request-changes, CO gets decline + counter, invoice got
// nothing. Deliberately not a status transition (see migration 046's
// comment on why disputed_at/dispute_note are informational columns, not
// a new invoices.status value) — this just records the concern and tells
// the agency, the same "make the silence visible" job every other portal
// action already does.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { getWorkspaceJwtSecret, isWorkspaceDeleted } from '@/lib/utils/workspace-secret'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { sendInvoiceDisputedEmail } from '@/lib/email/templates'
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

    const { note } = await request.json()
    if (!note || note.trim().length < 10)
      return NextResponse.json({ error: 'Please describe the issue (minimum 10 characters)' }, { status: 400 })
    // FIX (build, cron/portal audit round): no maximum length existed —
    // same gap as SOW request-changes (see that route's identical fix).
    // This note is written into invoices.dispute_note, audit_log, a
    // notification body, and an email, unbounded.
    if (note.trim().length > 4000)
      return NextResponse.json({ error: 'Please keep your description under 4000 characters' }, { status: 400 })

    const { data: revoked } = await (service as any)
      .from('revoked_tokens').select('id').eq('token', token).single()
    if (revoked) return NextResponse.json({ error: 'Link no longer active' }, { status: 410 })

    const { data: invoice } = await (service as any)
      .from('invoices')
      .select('id, title, invoice_number, status, workspace_id, project_id, projects(id, name, clients(name, email))')
      .eq('token', token).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (invoice.status === 'draft' || invoice.status === 'void')
      return NextResponse.json({ error: 'This invoice is no longer available' }, { status: 409 })

    try {
      const jwtSecret = await getWorkspaceJwtSecret(service, invoice.workspace_id)
      if (!jwtSecret) throw new Error('no secret')
      const secret = new TextEncoder().encode(jwtSecret)
      await jwtVerify(token, secret)
    } catch {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })
    }

    // FIX (portal audit, section 18 — closing pass): every other client-
    // mutating portal action (SOW decline/request-changes, CO decline/
    // counter/accept/countersign) checks isWorkspaceDeleted right after
    // JWT verification — see that function's own comment in
    // workspace-secret.ts, which already names this route by name as part
    // of that fix. It never actually landed here: a client could still
    // submit a dispute (writing disputed_at/dispute_note and an audit_log
    // row) against a workspace the agency has deleted.
    if (await isWorkspaceDeleted(service, invoice.workspace_id))
      return NextResponse.json({ error: 'This link is no longer active' }, { status: 410 })

    const now = new Date().toISOString()
    const project = invoice.projects
    const client  = project?.clients

    // Not a CAS-guarded lifecycle transition — status is untouched, this
    // just stamps when + what. A client can re-flag with an updated note
    // any time; last write wins, same as any other informational field.
    await (service as any).from('invoices')
      .update({ disputed_at: now, dispute_note: note.trim() })
      .eq('id', invoice.id)

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
      metadata: { note: note.trim() },
    })

    await notifyMembersWithPermission(service, {
      workspaceId: invoice.workspace_id, permission: 'VIEW_FINANCIALS', eventType: 'invoice_disputed',
      type: 'invoice_disputed', title: `Invoice question — ${project?.name || invoice.title}`,
      body: `${client?.name || 'The client'}: ${note.trim()}`.slice(0, 160),
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
          note: note.trim(),
          projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project?.id}?tab=billing`,
        })
      }
    } catch (e) { console.error('Invoice disputed email failed:', e) }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Invoice dispute error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
