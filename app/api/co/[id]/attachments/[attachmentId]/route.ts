export const runtime = 'nodejs'

// DELETE /api/co/[id]/attachments/[attachmentId] — see ../route.ts for the feature this belongs to.
// Same draft-only lock as uploading: removal must not become a way to alter the working record of a change order
// that has already gone out.

import { isUuidString } from '@/lib/utils/uuid'
import { createServiceClient } from '@/lib/supabase/server'
import { lookupMissResponse } from '@/lib/documents/co-lookup'
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
    if (!isUuidString(id) || !isUuidString(attachmentId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

    const service = createServiceClient()
    const { data: co, error: coLookupErr } = await (service as any)
      .from('change_orders').select('id, project_id, status').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!co) return lookupMissResponse(coLookupErr, 'Not found')
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (co.status !== 'draft')
      return NextResponse.json({ error: 'This change order is locked — attachments can only be removed from a draft.' }, { status: 409 })
    if (await getPendingApprovalForDocument(service, 'co', id))
      return NextResponse.json({ error: 'This change order has a pending approval request — cancel it before changing attachments.' }, { status: 409 })

    // Scoped by co_id, not just id — an attachmentId from a different CO must 404, not delete.
    const { data: attachment, error: attachmentErr } = await (service as any)
      .from('co_attachments').select('id, storage_path, file_name').eq('id', attachmentId).eq('co_id', id).single()
    if (!attachment) return lookupMissResponse(attachmentErr, 'Not found')

    const { error: deleteError } = await (service as any)
      .from('co_attachments').delete().eq('id', attachmentId).eq('co_id', id)
    if (deleteError) throw new Error(deleteError.message)

    // A storage_path is NOT unique per row: revising a CO (lib/documents/co-version.ts) copies attachment rows onto
    // the new draft while pointing at the SAME Storage object, and the superseded version keeps its row (it is
    // locked and can never be edited). Removing the object unconditionally would silently break the file behind
    // every other version's copy, including historical ones. Only delete the object once no remaining row
    // references it; if the lookup itself fails, keep the object — an orphan is swept by storage-cleanup, a
    // dangling reference on a historical CO is unrecoverable.
    const { count: stillReferenced, error: refError } = await (service as any)
      .from('co_attachments').select('id', { count: 'exact', head: true })
      .eq('storage_path', attachment.storage_path)
    if (refError) {
      console.error('Could not check CO attachment references — keeping the storage object:', refError.message)
    } else if ((stillReferenced || 0) === 0) {
      // Best-effort, and only AFTER the row (the only record of the path) is gone; storage-cleanup sweeps stragglers.
      const { error: removeError } = await service.storage.from(EVIDENCE_BUCKET).remove([attachment.storage_path])
      if (removeError) console.error('Could not remove CO attachment object from storage:', removeError.message)
    }

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
