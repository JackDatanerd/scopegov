import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'

// FIX (section-10 audit, 10-G2 + 10-G3 + 10-G4):
//
// The CO negotiation loop had no way back from any non-accepted outcome.
//   - 10-G2: from 'countered' the only moves were Accept or Close. There
//     was no way to respond at a third number without destroying the CO
//     and rebuilding it from scratch, losing the line items, the Guardian
//     flag link, and the audit thread.
//   - 10-G3: CoCard rendered a "Negotiate" button on a declined CO that
//     linked to CoEditor — which sets isLocked = status !== 'draft', so
//     it opened read-only under a banner saying "Withdraw it to edit",
//     and withdraw isn't even permitted from 'declined'. The one labelled
//     recovery path from a client decline was a dead button.
//   - 10-G4: a withdrawn CO was equally terminal, under the same banner,
//     which made withdrawing strictly worse than doing nothing.
//
// Same shape as the SOW reopen route and the portal's own
// request-changes flow: clone forward into a new draft, leave the
// original intact and auditable as the thing the client actually saw.
// parent_co_id (which has existed on change_orders since migration 001
// and was never used) records the lineage.
const REVISABLE = ['declined', 'withdrawn', 'closed', 'countered']

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select(`id, title, note, status, version, project_id, flag_id,
        line_items, subtotal, tax_rate, tax_inclusive, total,
        counter_amount, counter_note, is_retainer_renewal,
        timeline_impact_days, scope_impact_note`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Change order not found' }, { status: 404 })
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (!REVISABLE.includes(co.status))
      return NextResponse.json(
        { error: `A ${co.status.replace(/_/g, ' ')} change order can't be revised.` },
        { status: 400 }
      )

    // line_items has been written both ways historically (see the
    // JSON.stringify note in app/api/co/route.ts) — handle both.
    const lineItems = typeof co.line_items === 'string'
      ? JSON.parse(co.line_items)
      : (co.line_items || [])

    const { data: latest } = await (service as any)
      .from('change_orders')
      .select('version')
      .eq('project_id', co.project_id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: revision, error: insertErr } = await (service as any)
      .from('change_orders')
      .insert({
        project_id:   co.project_id,
        workspace_id: session.workspaceId,
        parent_co_id: co.id,
        version:      (latest?.version || co.version || 0) + 1,
        status:       'draft',
        title:        co.title,
        note:         co.note,
        flag_id:      co.flag_id,
        line_items:   lineItems,
        subtotal:     co.subtotal,
        tax_rate:     co.tax_rate,
        tax_inclusive: co.tax_inclusive,
        total:        co.total,
        is_retainer_renewal:  co.is_retainer_renewal,
        timeline_impact_days: co.timeline_impact_days,
        scope_impact_note:    co.scope_impact_note,
        created_by:   session.id,
        // Deliberately NOT copied: token, sent_at, expires_at,
        // document_number, counter/accept/decline/close fields. The
        // revision has to earn all of those through a real send.
      })
      .select('id, version').single()

    if (insertErr || !revision) {
      console.error('CO revise: insert failed', insertErr)
      return NextResponse.json({ error: 'Could not create a revision' }, { status: 500 })
    }

    // A 'countered' CO is still live from the client's point of view —
    // superseding it with a revision means closing out the old one so it
    // stops showing as an open negotiation (and so its linked Guardian
    // flag reverts through the normal close path rather than being left
    // pointing at an abandoned CO).
    if (co.status === 'countered') {
      await (service as any).from('change_orders')
        .update({
          status: 'closed',
          close_reason: `Superseded by revision v${revision.version}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', co.id).eq('status', 'countered')
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.revised', entityType: 'change_order',
      entityId: revision.id, entityName: co.title,
      metadata: {
        from_co_id: co.id, from_status: co.status,
        from_version: co.version, new_version: revision.version,
        ...(co.counter_amount != null ? { client_counter_amount: co.counter_amount } : {}),
      },
    })

    return NextResponse.json({ coId: revision.id, version: revision.version })
  } catch (err) {
    console.error('CO revise error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
