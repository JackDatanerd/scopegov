export const runtime = 'nodejs'

// FEATURE (cron/portal audit round 2): an invoice dispute could be raised by the client but never answered or
// closed by the agency — "Client disputed" stayed on the invoice forever, even after it was paid. This
// closes one out, with an optional note the client is emailed (and sees on the portal page). A client can
// dispute again afterwards; the portal dispute route clears the resolution when they do.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { cleanTextField } from '@/lib/utils/sanitize'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { sendInvoiceDisputeResolvedEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const body = await request.json().catch(() => ({} as any))
    const cleaned = cleanTextField(body?.note, 2000)
    if (cleaned === null) return NextResponse.json({ error: 'note must be text' }, { status: 400 })
    const note = cleaned.trim() || null

    const service = createServiceClient()
    const { data: invoice } = await (service as any).from('invoices')
      .select(`id, title, invoice_number, status, token, project_id, disputed_at, dispute_resolved_at,
        projects(id, name, client_id, clients(name, email, cc_emails), workspaces(agency_name, brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!invoice.disputed_at)
      return NextResponse.json({ error: 'This invoice has no open dispute' }, { status: 400 })
    if (invoice.dispute_resolved_at)
      return NextResponse.json({ error: 'This dispute is already resolved' }, { status: 409 })

    const now = new Date().toISOString()
    // CAS on "still unresolved" so two teammates clicking at once don't both notify the client.
    const { data: updated, error: updErr } = await (service as any).from('invoices')
      .update({ dispute_resolved_at: now, dispute_resolution_note: note, dispute_resolved_by: session.id, updated_at: now })
      .eq('id', id).eq('workspace_id', session.workspaceId).is('dispute_resolved_at', null).select('id')
    if (updErr) {
      console.error('Dispute resolve failed:', updErr)
      return NextResponse.json({ error: 'Could not resolve the dispute — please try again.' }, { status: 500 })
    }
    if (!updated?.length) return NextResponse.json({ error: 'This dispute is already resolved' }, { status: 409 })

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.dispute_resolved', entityType: 'invoice', entityId: id, entityName: invoice.title,
      metadata: { note },
    })

    // Best effort — the dispute is resolved either way.
    // FIX (section-11/12 fix round): `emailed` was set to true right after the
    // `await`, inside a bare try/catch — the same gap as invoices/[id]/void
    // (see that route's comment): the Resend SDK resolves `{ error }` instead
    // of throwing on a rejected send, so this reported `emailed: true` even
    // when the client was never actually told. checkedSend (already used by
    // this invoice's own remind route, and by SOW/CO withdraw/close for the
    // equivalent client-facing email) makes `emailed` reflect what actually
    // happened.
    let emailed = false
    const project = invoice.projects
    const client = project?.clients
    if (client?.email && invoice.token) {
      const cc = await withPrimaryContactCc(service, project?.client_id, client.email, client.cc_emails, 'invoice')
      const delivery = await checkedSend(() => sendInvoiceDisputeResolvedEmail({
        to: client.email, cc, clientName: client.name || 'there',
        agencyName: project?.workspaces?.agency_name || session.agencyName,
        projectName: project?.name || invoice.title, invoiceNumber: invoice.invoice_number, note,
        portalUrl: `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/invoice/${invoice.token}`,
        brandColour: project?.workspaces?.brand_colour,
      }), 'Invoice dispute resolved (client) email')
      emailed = delivery.ok
    }

    return NextResponse.json({ ok: true, emailed })
  } catch (err) {
    console.error('Dispute resolve error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
