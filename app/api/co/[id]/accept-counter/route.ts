import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { sendCoCountersignatureRequestEmail } from '@/lib/email/templates'
import { rescaleLineItemsToTotal } from '@/lib/utils/rescale-line-items'

// FIX (doc-completeness audit, decision: require re-sign): this route used
// to finalize the CO as 'accepted' the moment the agency accepted the
// client's counter-offer — with no client signature ever captured for the
// negotiated amount. It now moves the CO to 'awaiting_countersignature'
// (migration 014) at the counter amount, issues a fresh signing link, and
// emails the client to countersign. The CO only becomes 'accepted' — and
// the amendment only gets created — once they do that, via
// /api/portal/co/[token]/countersign (see lib/documents/finalize-co.ts).
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
      .select(`id,title,status,flag_id,counter_amount,counter_note,line_items,subtotal,tax_rate,tax_inclusive,project_id,workspace_id,
        projects(id,name,currency,clients(name,email,cc_emails),workspaces(id,agency_name,brand_colour))`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (co.status !== 'countered')
      return NextResponse.json({ error: 'CO is not in countered status' }, { status: 400 })

    const project = co.projects
    const client  = project?.clients
    const ws      = project?.workspaces
    if (!client?.email) return NextResponse.json({ error: 'Client email required' }, { status: 400 })

    const jwtSecret = await getWorkspaceJwtSecret(service, session.workspaceId)
    if (!jwtSecret) return NextResponse.json({ error: 'Workspace signing secret not found' }, { status: 500 })
    const secret     = new TextEncoder().encode(jwtSecret)
    const expiresAt  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const newToken   = await new SignJWT({
      coId: id, workspaceId: session.workspaceId, projectId: co.project_id,
      clientEmail: client.email, action: 'countersign',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(expiresAt)
      .setJti(nanoid())
      .sign(secret)

    const now = new Date().toISOString()

    // FIX (doc-completeness audit, finding #5): previously this only
    // overwrote `total` with the counter amount, leaving `subtotal` and
    // `line_items` at their pre-negotiation values — so the eventual PDF
    // showed line items and a subtotal that didn't sum to the stated
    // total, with tax computed off the stale subtotal on top of that.
    // Reconcile line items, subtotal, and total against the negotiated
    // amount via an explicit adjustment line (see rescale-line-items.ts —
    // it no longer rescales existing rates, on purpose).
    const negotiatedTotal = co.counter_amount || co.total
    const existingLineItems = typeof co.line_items === 'string'
      ? JSON.parse(co.line_items) : (co.line_items || [])
    const { lineItems: rescaledLineItems, subtotal: rescaledSubtotal, total: rescaledTotal } =
      rescaleLineItemsToTotal(existingLineItems, negotiatedTotal, co.tax_rate || 0, !!co.tax_inclusive)

    // FIX (re-audit, race-condition finding): CAS on the status this route
    // itself just checked above — the read-then-write gap between that
    // check and this write is a real window (two staff members, or one
    // double-clicking Accept). Without this, a lost race would still
    // silently overwrite the winner's negotiated line items/token/expiry
    // and fire a second countersignature-request email carrying a token
    // that immediately doesn't match the row anymore. See
    // lib/documents/finalize-co.ts for the matching client-side fix.
    const { data: updatedCo, error: updateErr } = await (service as any)
      .from('change_orders').update({
        status:              'awaiting_countersignature',
        counter_accepted_at: now,
        counter_accepted_by: session.name,
        line_items:          rescaledLineItems,
        subtotal:            rescaledSubtotal,
        total:               rescaledTotal,
        token:               newToken,
        expires_at:          expiresAt.toISOString(),
        responded_at:        now,
        updated_at:          now,
      })
      .eq('id', id)
      .eq('status', 'countered')
      .select('id')

    if (updateErr) return NextResponse.json({ error: 'Failed to accept counter' }, { status: 500 })
    if (!updatedCo || updatedCo.length === 0)
      return NextResponse.json({ error: 'This counter-offer was already responded to' }, { status: 409 })

    // Flag resolution and amendment creation now happen once the client
    // actually countersigns (finalizeCoAcceptance), not here.

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.counter_accepted', entityType: 'change_order',
      entityId: id, entityName: co.title,
      metadata: { counter_amount: co.counter_amount, accepted_by: session.name, awaiting_countersignature: true },
    })

    const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/co/${newToken}`
    try {
      await sendCoCountersignatureRequestEmail({
        to: client.email, cc: client.cc_emails || [],
        clientName: client.name, agencyName: ws?.agency_name,
        projectName: project?.name, coTitle: co.title,
        total: co.counter_amount || co.total, currency: project?.currency || 'USD',
        portalUrl, brandColour: ws?.brand_colour,
      })
    } catch (e) { console.error('CO countersignature request email failed:', e) }

    return NextResponse.json({ ok: true, awaitingCountersignature: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
