import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { evaluateApprovalGate } from '@/lib/approvals/engine'
import { acceptCoCounter } from '@/lib/documents/accept-co-counter'

// FIX (doc-completeness audit, decision: require re-sign): this route used
// to finalize the CO as 'accepted' the moment the agency accepted the
// client's counter-offer — with no client signature ever captured for the
// negotiated amount. It now moves the CO to 'awaiting_countersignature'
// (migration 014) at the counter amount, issues a fresh signing link, and
// emails the client to countersign. The CO only becomes 'accepted' — and
// the amendment only gets created — once they do that, via
// /api/portal/co/[token]/countersign (see lib/documents/finalize-co.ts).
//
// FIX (section-11 audit, headline finding): this route never re-checked
// the approval-workflow gate against the NEGOTIATED amount — a CO could
// send fine at $5,000 under a "$10k+ needs approval" workflow, get
// countered to $75,000, and have that counter accepted with zero sign-off,
// since the gate only ever ran once, at the original (lower) send. The
// actual finalize logic is now in lib/documents/accept-co-counter.ts so it
// can be invoked either directly here (ungated) or from
// lib/approvals/engine.ts's recordApprovalDecision() on final approval
// (gated) — same split as the regular SOW/CO send routes.
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
      .select(`id,title,status,flag_id,counter_amount,total,project_id,workspace_id,
        projects(id,name,currency)`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (co.status !== 'countered')
      return NextResponse.json({ error: 'CO is not in countered status' }, { status: 400 })

    const project = co.projects
    const negotiatedTotal = co.counter_amount || co.total

    // FIX (section-11 audit): gate on the NEGOTIATED amount, using the
    // same 'co' workflows an admin already configured — a counter-offer
    // shouldn't need its own separate workflow type to be covered.
    const gate = await evaluateApprovalGate(service, {
      workspaceId:  session.workspaceId,
      documentType: 'co_counter',
      documentId:   id,
      projectId:    co.project_id,
      projectName:  project?.name || '',
      amount:       negotiatedTotal || 0,
      currency:     project?.currency || 'USD',
      documentTitle: co.title,
      requestedBy:  { id: session.id, name: session.name, email: session.email },
    })

    if (gate.requiresApproval) {
      return NextResponse.json({
        ok: true,
        pendingApproval: true,
        approvalRequestId: gate.approvalRequestId,
        message: 'Sent for approval — the client will be notified once it clears.',
      })
    }

    const result = await acceptCoCounter(service, {
      coId: id,
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
    })

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, awaitingCountersignature: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
