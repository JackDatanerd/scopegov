export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'

// FEATURE (independent pass, section 14): duplicate clients (the same company entered under two
// email addresses) had no fix — no delete, no merge. This moves every project, saved contact and
// CC address from THIS client (the source) into `targetId`, then removes the source. Runs as one
// database transaction (merge_clients, migration 077, most recently touched by 089). It deletes a
// client record, so it needs the same DELETE_PROJECTS permission the plain delete does, plus the
// usual client-edit permissions.
//
// FIX (independent pass round 5, section 14): merge_clients() (089) now caps how many of the
// source's contacts get moved at the target's remaining room under the 25-per-client limit, and
// reports how many didn't fit as `contacts_dropped` — surfaced here (and in the audit row) instead
// of the loss being silent, same as `contacts_moved` already was.
//
// FIX (independent pass round 6, section 14): merge_clients() (097) now reports the parallel loss on
// the OTHER side of a merge — the source's cc_emails (and its own primary email) can be capped at
// MAX_CC_EMAILS the same way contacts are capped at MAX_CONTACTS_PER_CLIENT, and that cap was silent
// until now. `cc_dropped` is surfaced here the same way `contacts_dropped` already is.
//
// FIX (independent pass 2, section 14): merge_clients() (098) also carries the source's billing address,
// VAT number, phone, timezone, payment-terms note, company name and notes over to the target wherever the
// target has none of its own (the target's values always win) — previously they were deleted with the
// source row, so the moved projects' invoice/SOW/CO PDFs lost their Bill To block. The names of the fields
// carried are recorded in the audit row (`fields`), which the client page's activity list displays.
//
// FIX (independent pass 2, section 14): a merge reassigns EVERY project of the source, including ones the
// caller has no access to (VIEW_ALL_PROJECTS is what scopes project visibility everywhere else) — a
// limited-access member could silently move projects they can't even open, while the confirm dialog told
// them "all of X's projects" were moving. Merging is a workspace-wide operation, so it needs it too.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: sourceId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS') || !hasPermission(session, 'VIEW_CLIENT_DATA') || !hasPermission(session, 'DELETE_PROJECTS') || !hasPermission(session, 'VIEW_ALL_PROJECTS'))
      return NextResponse.json({ error: 'Merging clients needs CREATE_PROJECTS, VIEW_CLIENT_DATA, DELETE_PROJECTS and VIEW_ALL_PROJECTS' }, { status: 403 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    const targetId = body?.targetId
    if (typeof targetId !== 'string' || !targetId) return NextResponse.json({ error: 'targetId is required' }, { status: 400 })
    if (targetId === sourceId) return NextResponse.json({ error: 'Choose a different client to merge into.' }, { status: 400 })

    const service = createServiceClient()
    const { data: rows } = await (service as any).from('clients')
      .select('id, name, email').eq('workspace_id', session.workspaceId).in('id', [sourceId, targetId])
    const source = rows?.find((c: any) => c.id === sourceId)
    const target = rows?.find((c: any) => c.id === targetId)
    if (!source || !target) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

    const { data: result, error } = await (service as any).rpc('merge_clients', {
      p_workspace_id: session.workspaceId, p_source: sourceId, p_target: targetId,
    })
    if (error) {
      if (/not_found/.test(error.message)) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      throw new Error(error.message)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client.merged', entityType: 'client', entityId: targetId, entityName: target.name,
      metadata: {
        merged_from: { id: source.id, name: source.name, email: source.email },
        projects_moved: result?.projects_moved ?? null, contacts_moved: result?.contacts_moved ?? null,
        contacts_dropped: result?.contacts_dropped ?? null, cc_dropped: result?.cc_dropped ?? null,
        fields: Array.isArray(result?.fields_carried) ? result.fields_carried : [],
        notes_truncated: result?.notes_truncated === true,
      },
    })
    return NextResponse.json({ ok: true, targetId, ...result })
  } catch (err) {
    console.error('Client merge error:', err)
    return NextResponse.json({ error: 'Could not merge the clients' }, { status: 500 })
  }
}
