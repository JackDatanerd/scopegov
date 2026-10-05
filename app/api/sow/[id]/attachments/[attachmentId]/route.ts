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

import { isUuidString } from '@/lib/utils/uuid'
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
    if (!isUuidString(id) || !isUuidString(attachmentId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow, error: sowReadErr } = await (service as any)
      .from('sow_documents').select('id, project_id, sent_at').eq('id', id)
      .eq('workspace_id', session.workspaceId).maybeSingle()
    // FIX (SOW lifecycle independent pass 15, B4): a failed read is not "not found" — fail into the route's 500 handler.
    if (sowReadErr) throw new Error(`SOW read failed: ${sowReadErr.message}`)
    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (sow.sent_at) return NextResponse.json({ error: 'SOW is locked — attachments can only be removed from a draft.' }, { status: 409 })
    // FIX (section-11 audit, pass 1 — B1): see the POST route — a SOW in an approval chain is still
    // 'draft', so removing an attachment would change a document approvers already reviewed.
    if (await getPendingApprovalForDocument(service, 'sow', id))
      return NextResponse.json({ error: 'This SOW has a pending approval request — cancel it before changing attachments.' }, { status: 409 })

    // FIX (SOW lifecycle, round 8, B4): the checks above are only a fast path. Adding an attachment has been
    // atomic since migration 109/117 (sow_attachment_add rechecks the draft lock and the approval lock under a row
    // lock); this delete used to be a bare read-then-delete, so one landing between a send (or an approval request)
    // and this write still removed a file from a document that had just been locked. sow_attachment_remove (migration
    // 138) takes the same lock, applies the same two refusals, and scopes the delete to this SOW — an attachmentId
    // that belongs to a different SOW (even one in this workspace) is "attachment_not_found", not a delete.
    let attachment: { storage_path: string; file_name: string } | null = null
    const { data: removed, error: removeRpcErr } = await (service as any)
      .rpc('sow_attachment_remove', { p_sow_id: id, p_attachment_id: attachmentId })
    if (!removeRpcErr && removed) {
      attachment = { storage_path: removed.storage_path, file_name: removed.file_name }
    } else {
      const msg = String(removeRpcErr?.message || '')
      // A malformed attachmentId is just "no such attachment" (the old select answered 404 for it too).
      if (msg.includes('attachment_not_found') || msg.includes('sow_not_found') || /invalid input syntax/i.test(msg))
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (msg.includes('sow_locked'))
        return NextResponse.json({ error: 'SOW is locked — attachments can only be removed from a draft.' }, { status: 409 })
      if (msg.includes('sow_approval_pending'))
        return NextResponse.json({ error: 'This SOW has a pending approval request — cancel it before changing attachments.' }, { status: 409 })
      // Function not installed yet (migration 138 not applied): fall back to the guarded-by-fast-path delete this
      // route always had, rather than making attachments undeletable until the migration is run.
      if (!/could not find the function|PGRST202|does not exist/i.test(msg + String((removeRpcErr as any)?.code || '')))
        throw new Error(removeRpcErr?.message || 'sow_attachment_remove returned no row')
      console.error('sow_attachment_remove unavailable, falling back to non-atomic delete:', msg)
      const { data: found } = await (service as any)
        .from('sow_attachments').select('id, storage_path, file_name').eq('id', attachmentId).eq('sow_id', id).single()
      if (!found) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const { error: deleteError } = await (service as any)
        .from('sow_attachments').delete().eq('id', attachmentId).eq('sow_id', id)
      if (deleteError) throw new Error(deleteError.message)
      attachment = { storage_path: found.storage_path, file_name: found.file_name }
    }

    // FIX (section-9 independent pass): a storage_path is NOT unique per row. Reopening a SOW (and
    // the portal's request-changes) copies attachment rows onto the new draft via
    // lib/documents/sow-version.ts while pointing at the SAME Storage object — the superseded
    // version keeps its row (it is locked and can never be edited). Removing the object
    // unconditionally here would silently break the file behind every other version's copy of this
    // attachment, including closed historical versions. Only delete the object once no remaining
    // row references it. If the lookup itself fails, keep the object: an orphan is swept up by
    // storage-cleanup, a dangling reference on a historical SOW is unrecoverable.
    const { count: stillReferenced, error: refError } = await (service as any)
      .from('sow_attachments').select('id', { count: 'exact', head: true })
      .eq('storage_path', attachment.storage_path)
    if (refError) {
      console.error('Could not check SOW attachment references — keeping the storage object:', refError.message)
    } else if ((stillReferenced || 0) === 0) {
      // Best-effort: the row is gone either way — an orphaned Storage object
      // is cleaned up later by the same purge-time sweep in
      // lib/utils/storage-cleanup.ts if this remove() call fails, never the
      // other way around (never delete the object while the row, the only
      // record of its path, still exists).
      const { error: removeError } = await service.storage.from(EVIDENCE_BUCKET).remove([attachment.storage_path])
      if (removeError) console.error('Could not remove SOW attachment object from storage:', removeError.message)
    }

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
