export const runtime = 'nodejs'
// FIX (section-11 audit, B4): the FINAL approval / a retry runs the whole document send inside this request
// (invoice: PDF render + client email + internal notifications). Without a maxDuration the platform default
// can cut it off mid-send — the document may already have gone out while the request is left mid-flight for
// healStuckSends to sweep 10 minutes later. Matches the other long-running send/cron routes.
export const maxDuration = 60

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { retryFailedSend } from '@/lib/approvals/engine'
import { canReadProject } from '@/lib/utils/project-access'

// FIX (section-11 fix round, flagship finding): see migration 053 +
// lib/approvals/engine.ts (recordApprovalDecision/retryFailedSend). Before
// this route existed, the only way to recover from a failed auto-send was
// to manually click Send again on the still-draft document — which
// silently restarted the ENTIRE approval chain from step 1, re-notifying
// every approver to decide something they'd already decided. This retries
// only the mechanical send against a request that's already 'approved'.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: req, error: reqErr } = await (service as any)
      .from('approval_requests')
      .select('id, requested_by, status, send_failed_at, project_id')
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .maybeSingle()
    // FIX (approvals pass 14): a failed read answered 404 "not found" (.single() with `error` unread).
    if (reqErr) {
      console.error('Approval retry-send: request lookup failed:', reqErr)
      return NextResponse.json({ error: 'Could not load this approval request — please try again.' }, { status: 500 })
    }

    if (!req) return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
    // Same requester-or-admin authorization as cancel — it's the same
    // document, just a later stage of the same lifecycle.
    if (req.requested_by !== session.id && !hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Only the requester or an admin can retry sending this' }, { status: 403 })
    // FIX (fix round, section-11 finding): same gap and same fix as
    // cancel/route.ts — retry-send is, if anything, the more consequential
    // of the two (it fires a real email to the client), and had the exact
    // same missing project-visibility check for the admin-override branch.
    if (!(await canReadProject(service, session, req.project_id)))
      return NextResponse.json({ error: 'You do not have access to this project' }, { status: 403 })
    if (req.status !== 'approved' || !req.send_failed_at)
      return NextResponse.json({ error: 'This request has nothing to retry' }, { status: 400 })

    const result = await retryFailedSend(service, {
      requestId: id, workspaceId: session.workspaceId,
      actor: { id: session.id, email: session.email, name: session.name },
    })

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, ...(result.deliveryWarning ? { deliveryWarning: result.deliveryWarning } : {}) })
  } catch (err) {
    console.error('Approval retry-send error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
