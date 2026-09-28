export const runtime = 'nodejs'

// DELETE /api/co/[id]/attachments/[attachmentId] — see ../route.ts for the feature this belongs to.
// Same draft-only lock as uploading: removal must not become a way to alter the working record of a change order
// that has already gone out.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  try {
    const { id, attachmentId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders').select('id, project_id, status').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (co.status !== 'draft')
      return NextResponse.json({ error: 'This change order is locked — attachments can only be removed from a draft.' }, { status: 409 })
    if (await getPendingApprovalForDocument(service, 'co', id))
      return NextResponse.json({ error: 'This change order has a pending approval request — cancel it before changing attachments.' }, { status: 409 })

    // Scoped by co_id, not just id — an attachmentId from a different CO must 404, not delete.
    const { data: attachment } = await (service as any)
      .from('co_attachments').select('id, storage_path, file_name').eq('id', attachmentId).eq('co_id', id).single()
    if (!attachment) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { error: deleteError } = await (service as any)
      .from('co_attachments').delete().eq('id', attachmentId).eq('co_id', id)
    if (deleteError) throw new Error(deleteError.message)

    // Best-effort, and only AFTER the row (the only record of the path) is gone; storage-cleanup sweeps stragglers.
    const { error: removeError } = await service.storage.from(EVIDENCE_BUCKET).remove([attachment.storage_path])
    if (removeError) console.error('Could not remove CO attachment object from storage:', removeError.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'co_attachment.removed', entityType: 'change_order', entityId: id,
      metadata: { attachment_id: attachmentId, file_name: attachment.file_name },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('CO attachment DELETE error:', err)
    return NextResponse.json({ error: 'Could not remove attachment — please try again.' }, { status: 500 })
  }
}
