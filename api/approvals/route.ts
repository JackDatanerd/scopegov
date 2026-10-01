export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { healStuckSends } from '@/lib/approvals/engine'
import { SEND_CLAIM_WINDOW_MS } from '@/lib/approvals/send-claim'
import { fetchAll } from '@/lib/utils/fetch-all'
import {
  REQUEST_FIELDS, LIGHT_REQUEST_FIELDS, allowedProjectIdsFor, canDecideRequest, decorate,
} from '@/lib/approvals/list'

const STATUS_FILTERS = new Set(['pending', 'approved', 'rejected', 'cancelled'])
const TYPE_FILTERS   = new Set(['sow', 'co', 'co_counter', 'invoice'])

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()
    const params = request.nextUrl.searchParams
    const scope = params.get('scope') || 'mine'
    const statusFilter = params.get('status') || ''
    const typeFilter = params.get('type') || ''
    // FIX (section-11 audit, pass 1 — B2): `light=1` is the count-only mode the sidebar badge (and the
    // page's "My queue (n)" label) use — a slim select, no lazy heal, and only { count } comes back instead of
    // every request with its four embeds on every navigation. `sendFailed=1` filters approved-but-not-sent
    // requests IN THE QUERY: the badge used to page down every approved request a member had ever submitted
    // just to keep the few with send_failed_at set (its own comment said "filter server-side" — only
    // `status` was).
    const light = params.get('light') === '1'
    const sendFailedOnly = params.get('sendFailed') === '1'
    const FIELDS = light ? LIGHT_REQUEST_FIELDS : REQUEST_FIELDS
    if (statusFilter && !STATUS_FILTERS.has(statusFilter))
      return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 })
    if (typeFilter && !TYPE_FILTERS.has(typeFilter))
      return NextResponse.json({ error: 'Invalid type filter' }, { status: 400 })

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('role_id')
      .eq('workspace_id', session.workspaceId)
      .eq('user_id', session.id)
      .eq('status', 'active')
      .maybeSingle()
    const roleId: string | null = member?.role_id ?? null

    // FIX (independent pass 3): lazy self-heal — see healStuckSends' own
    // comment in lib/approvals/engine.ts. Scoped to this session's workspace
    // only, so a busy Approvals page doesn't turn into a cross-workspace
    // table scan on every load. Best-effort: a failure here must never break
    // the list itself.
    if (!light) {
      // FIX (section-11 independent pass 10, B2): same window the cancel route and the gate treat as "dead" (2 min), not
      // 10 — between the two the request showed "Sending…" with no Cancel/Retry offered.
      try { await healStuckSends(service, SEND_CLAIM_WINDOW_MS / 60000, session.workspaceId) } catch (e) { console.error('lazy healStuckSends failed:', e) }
    }
    const respond = (rows: any[], scopeName: string) => light
      ? NextResponse.json({ count: rows.length, scope: scopeName })
      : NextResponse.json({ requests: decorate(rows, session, roleId), scope: scopeName })

    // Workspace-wide view — everything, any status, for oversight. Gated
    // behind VIEW_ALL_PROJECTS, or MANAGE_WORKSPACE_SETTINGS since that's who
    // configures the workflows in the first place.
    if (scope === 'all') {
      if (!hasPermission(session, 'VIEW_ALL_PROJECTS') && !hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
        return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

      // FIX (section-11 audit, independent pass 4): this used a bare
      // .limit(500) with no truncation detection — the exact class of bug
      // already fixed everywhere else "big reads" happen in this codebase
      // (portfolio-data.ts, scope-health.ts, the invoice registry/export).
      // A workspace with more than 500 approval_requests (across every
      // status/type, since this is the oversight view with no default
      // status filter) silently dropped the oldest ones past the cap with
      // no signal to the viewer. fetchAll pages through all of them (up to
      // its safety ceiling), same as the invoice registry's own ledger read.
      const rows = await fetchAll<any>('approvals list (all)', (from, to) => {
        let q = (service as any)
          .from('approval_requests')
          .select(FIELDS)
          .eq('workspace_id', session.workspaceId)
        if (statusFilter) q = q.eq('status', statusFilter)
        if (typeFilter) q = q.eq('document_type', typeFilter)
        return q.order('created_at', { ascending: false }).order('id').range(from, to)
      })

      // FIX (section-11 audit, pass 2): MANAGE_WORKSPACE_SETTINGS alone (no
      // VIEW_ALL_PROJECTS) used to return every project's requests — titles,
      // project names, amounts — for projects the viewer can't open. Every
      // other route treats canReadProject as the visibility boundary; the
      // oversight list now does too.
      const allowed = await allowedProjectIdsFor(service, session)
      const visible = rows.filter((r: any) => !allowed || allowed.has(r.project_id))
      return respond(visible, 'all')
    }

    // The ORIGINAL REQUESTER's own submissions — pending, decided or send-failed.
    // Scoped strictly to the caller's own requests; requested_by = session.id
    // is inherently "yours to see". The Approvals page now shows this as a tab
    // ("My requests") for everyone, not only as the retry banner.
    if (scope === 'submitted') {
      // FIX (section-11 audit, independent pass 4): same bare-.limit(200)-with-
      // no-truncation-signal gap as the 'all' scope above — a heavy submitter
      // (or one with a lot of decided/rejected history, since this scope has
      // no default status filter) could have their oldest own requests drop
      // off "My requests" with nothing to indicate anything was cut.
      const rows = await fetchAll<any>('approvals list (submitted)', (from, to) => {
        let q = (service as any)
          .from('approval_requests')
          .select(FIELDS)
          .eq('workspace_id', session.workspaceId)
          .eq('requested_by', session.id)
        if (statusFilter) q = q.eq('status', statusFilter)
        if (typeFilter) q = q.eq('document_type', typeFilter)
        // send_failed_at is only ever set on a request that is (still) status 'approved'.
        if (sendFailedOnly) q = q.eq('status', 'approved').not('send_failed_at', 'is', null)
        return q.order('created_at', { ascending: false }).order('id').range(from, to)
      })
      return respond(rows, 'submitted')
    }

    // "Mine" — pending requests whose CURRENT step this viewer can decide.
    // Filtered in JS because "the pending step" is the one whose step_order
    // matches the request's current_step, which isn't expressible as a single
    // PostgREST filter across the join.
    // FIX (section-11 audit, independent pass 4): this used a bare .limit(500)
    // ordered created_at ASCENDING — the worst version of the truncation bug
    // above, since ascending order means it's the OLDEST 500 pending requests
    // that get kept and every NEWER one silently dropped once a workspace
    // passes 500 pending requests workspace-wide (this query has no status
    // filter beyond 'pending', so it's every pending request of every type,
    // not just what a given viewer can act on). A brand-new approval assigned
    // to someone could never appear in "My queue" or the sidebar badge at all
    // until 500 older ones clear — exactly backwards from what a live alert
    // queue needs. fetchAll removes the cap (up to its own safety ceiling).
    const pending = await fetchAll<any>('approvals list (mine, pending)', (from, to) =>
      (service as any)
        .from('approval_requests')
        .select(FIELDS)
        .eq('workspace_id', session.workspaceId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .order('id')
        .range(from, to)
    )

    // A project-restricted VIEW_OWN_PROJECTS member isn't exempt just because
    // they hold the assigned role, or are the named approver, on a document
    // outside their project access (same rule as notifyStepApprovers and the
    // decision route).
    const allowed = await allowedProjectIdsFor(service, session)
    const mine = pending.filter((r: any) => {
      if (allowed && !allowed.has(r.project_id)) return false
      return canDecideRequest(r, session, roleId)
    })

    return respond(mine, 'mine')
  } catch (err) {
    console.error('Approvals list error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
