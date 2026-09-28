export const runtime = 'nodejs'

// DELETE /api/sow/[id]/attachments/[attachmentId]
//
// See the parent route's header comment (feature gap this closes). Deletion
// is deliberately allowed here — unlike flag_attachments, which has no
// DELETE route at all because it's an evidence trail an approver relies on
// — a SOW attachment is reference material the agency uploaded itself
// (a brief, mockups, a client doc) and may reasonably want to remove or
// replace before sending; the same draft-only lock below prevents it from
// becoming a way to alter what a client actually saw after the fact.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  try {
    const { id, attachmentId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents').select('id, project_id, sent_at').eq('id', id)
      .eq('workspace_id', session.workspaceId).single()
    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (sow.sent_at) return NextResponse.json({ error: 'SOW is locked — attachments can only be removed from a draft.' }, { status: 409 })

    // Scoped by sow_id, not just id — an attachmentId that belongs to a
    // different SOW (even one in this same workspace) must 404, not delete.
    const { data: attachment } = await (service as any)
      .from('sow_attachments').select('id, storage_path, file_name').eq('id', attachmentId).eq('sow_id', id).single()
    if (!attachment) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { error: deleteError } = await (service as any)
      .from('sow_attachments').delete().eq('id', attachmentId).eq('sow_id', id)
    if (deleteError) throw new Error(deleteError.message)

    // Best-effort: the row is gone either way — an orphaned Storage object
    // is cleaned up later by the same purge-time sweep in
    // lib/utils/storage-cleanup.ts if this remove() call fails, never the
    // other way around (never delete the object while the row, the only
    // record of its path, still exists).
    const { error: removeError } = await service.storage.from(EVIDENCE_BUCKET).remove([attachment.storage_path])
    if (removeError) console.error('Could not remove SOW attachment object from storage:', removeError.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'sow_attachment.removed', entityType: 'sow', entityId: id,
      metadata: { attachment_id: attachmentId, file_name: attachment.file_name },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('SOW attachment DELETE error:', err)
    return NextResponse.json({ error: 'Could not remove attachment — please try again.' }, { status: 500 })
  }
}
