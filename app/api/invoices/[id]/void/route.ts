export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const reason: string | undefined = body?.reason?.trim()

    const service = createServiceClient()
    const { data: invoice } = await (service as any)
      .from('invoices')
      .select('id, title, status, amount_paid, token, milestone_id, project_id')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!(await canReadProject(service, session, invoice.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (invoice.status === 'void')
      return NextResponse.json({ error: 'Invoice is already void' }, { status: 400 })
    if (invoice.status === 'paid')
      return NextResponse.json({ error: 'A fully paid invoice cannot be voided' }, { status: 400 })
    if (Number(invoice.amount_paid) > 0)
      return NextResponse.json({ error: 'Remove or correct recorded payments before voiding this invoice' }, { status: 400 })

    const now = new Date().toISOString()
    const { error } = await (service as any).from('invoices').update({
      status:      'void',
      voided_at:   now,
      void_reason: reason || null,
      updated_at:  now,
    }).eq('id', id)

    if (error) return NextResponse.json({ error: 'Failed to void invoice' }, { status: 500 })

    // Revoke the portal token, same pattern as SOW/CO withdraw — the client
    // link should stop resolving once an invoice is voided.
    if (invoice.token) {
      await (service as any).from('revoked_tokens').insert({
        token: invoice.token, token_type: 'invoice', revoked_by: session.id, reason: reason || 'voided',
      })
    }

    // If this invoice had put the milestone in 'invoiced', revert it to
    // 'pending' so it doesn't silently look billed when it no longer is.
    if (invoice.milestone_id) {
      await (service as any).from('payment_milestones')
        .update({ status: 'pending', invoiced_at: null })
        .eq('id', invoice.milestone_id).eq('status', 'invoiced')
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'invoice.voided', entityType: 'invoice',
      entityId: id, entityName: invoice.title, metadata: { reason: reason || null },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
