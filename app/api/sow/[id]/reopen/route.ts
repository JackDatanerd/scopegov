export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { isTerminalStatus } from '@/lib/utils/project-status'
import { insertNextSowVersion } from '@/lib/documents/sow-version'

// FIX (section-9 audit, 9-G1 + 9-G2 — the headline structural gap):
//
// Every non-happy-path terminal SOW state was a cul-de-sac. Once a SOW
// reached 'withdrawn', 'declined' or 'expired':
//   - ProjectDetail's SOW tab rendered ZERO actions (Edit/Send gate on
//     status==='draft'; Remind/Withdraw on 'awaiting_signature'), and the
//     "Generate SOW" button only renders when the project has no SOWs at
//     all — so there was no button anywhere to move forward.
//   - PATCH /api/sow/[id] refused with "SOW is locked after sending.
//     Withdraw to edit." — but withdraw never cleared sent_at, so after
//     withdrawing you hit the identical 409. The error text instructed an
//     action that could not resolve it.
// A client declining a SOW — the most common outcome the product has to
// handle after signature — simply halted the product.
//
// The fix is the pattern the codebase already proves works: the client
// portal's request-changes route responds to "client didn't accept this"
// by cloning the document into a fresh draft at version+1 with
// previous_version_id set. This does the same thing for the three states
// that never got it. A new draft (rather than unlocking the old row) is
// the right shape for a governance product: the withdrawn/declined
// version stays intact and auditable as the thing the client actually
// saw, and the new version carries its own number, token and signature.
const REOPENABLE = ['withdrawn', 'declined', 'expired']

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id, status, version, sections, metadata, project_id, projects(id, name, status)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (!REOPENABLE.includes(sow.status))
      return NextResponse.json(
        { error: `A ${sow.status.replace(/_/g, ' ')} SOW can't be reopened.` },
        { status: 400 }
      )

    // FIX (section-9 fix round): same gap as generate — send-sow.ts refuses to send a
    // SOW to a Complete/Archived project, but reopen (which also just creates a fresh
    // draft) never checked. A withdrawn/declined/expired SOW on a project closed out in
    // the meantime could still be "reopened" into a new draft that could then never be
    // sent, with no explanation until the send attempt itself.
    if (sow.projects && isTerminalStatus(sow.projects.status)) {
      return NextResponse.json({
        error: `This project is ${String(sow.projects.status).toLowerCase()} — a SOW can no longer be reopened. Reopen the project first.`,
      }, { status: 409 })
    }

    // If a draft already exists on this project (e.g. someone hit this
    // twice, or a request-changes draft is already open), point the caller
    // at that instead of stacking up abandoned versions.
    const { data: existingDraft } = await (service as any)
      .from('sow_documents')
      .select('id')
      .eq('project_id', sow.project_id)
      .eq('status', 'draft')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingDraft) {
      return NextResponse.json({ sowId: existingDraft.id, existing: true })
    }

    // Reopening only makes sense for the newest version of a project with no live SOW. Cloning
    // an old declined v1 while v2 is signed (or out for signature) produced a stale draft that,
    // once sent, would sit next to the real agreement.
    const { data: newerOrLive } = await (service as any)
      .from('sow_documents').select('id, status, version')
      .eq('project_id', sow.project_id).neq('id', sow.id)
      .or(`version.gt.${sow.version},status.in.(awaiting_signature,signed)`).limit(1)
    if (newerOrLive && newerOrLive.length > 0) {
      const n = newerOrLive[0]
      return NextResponse.json({
        error: n.status === 'signed'
          ? 'This project already has a signed SOW. Use a change order to change the agreed scope.'
          : n.status === 'awaiting_signature'
            ? `SOW v${n.version} is out for signature. Withdraw it before reopening an older version.`
            : `A newer version (v${n.version}) exists — reopen that one instead.`,
      }, { status: 409 })
    }

    // Clone content forward. Deliberately NOT copied: token, sent_at,
    // expires_at, document_number, signature/decline fields — the new
    // draft has to earn all of those through a real send.
    const result = await insertNextSowVersion(service, sow.project_id, {
      workspace_id:        session.workspaceId,
      status:              'draft',
      sections:            sow.sections,
      // The previous round's change-request note describes a different draft; carrying it forward
      // showed a stale "client requested changes" banner on an unrelated new version.
      metadata:            (({ changeRequest: _cr, ...rest }) => rest)(sow.metadata || {}),
      previous_version_id: sow.id,
    })

    if (!result.ok) {
      // Lost a race with another reopen: the one-draft-per-project index (migration 061) refused ours.
      if (/one_draft_per_project|duplicate key/i.test(result.error || '')) {
        const { data: winner } = await (service as any)
          .from('sow_documents').select('id').eq('project_id', sow.project_id).eq('status', 'draft').maybeSingle()
        if (winner) return NextResponse.json({ sowId: winner.id, existing: true })
      }
      console.error('SOW reopen: could not create version', result.error)
      return NextResponse.json({ error: 'Could not create a new version' }, { status: 500 })
    }

    // Bring the project back to a working state. Only move it out of the
    // statuses this SOW's own terminal state put it in — a project
    // stalled or paused for an unrelated reason stays as it is.
    await (service as any).from('projects')
      .update({ status: 'Intake', stall_reason: null, updated_at: new Date().toISOString() })
      .eq('id', sow.project_id)
      .in('status', ['Awaiting Signature', 'Changes Requested', 'Stalled'])

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'sow.reopened', entityType: 'sow',
      entityId: result.id!, entityName: sow.projects?.name,
      metadata: { from_sow_id: sow.id, from_status: sow.status, from_version: sow.version, new_version: result.version },
    })

    return NextResponse.json({ sowId: result.id, version: result.version })
  } catch (err) {
    console.error('SOW reopen error:', err)
    return NextResponse.json({ error: 'Could not reopen this SOW. Please try again.' }, { status: 500 })
  }
}
