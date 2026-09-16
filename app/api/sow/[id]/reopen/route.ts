export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
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

    // Clone content forward. Deliberately NOT copied: token, sent_at,
    // expires_at, document_number, signature/decline fields — the new
    // draft has to earn all of those through a real send.
    const result = await insertNextSowVersion(service, sow.project_id, {
      workspace_id:        session.workspaceId,
      status:              'draft',
      sections:            sow.sections,
      metadata:            sow.metadata,
      previous_version_id: sow.id,
    })

    if (!result.ok)
      return NextResponse.json({ error: result.error || 'Could not create a new version' }, { status: 500 })

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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
