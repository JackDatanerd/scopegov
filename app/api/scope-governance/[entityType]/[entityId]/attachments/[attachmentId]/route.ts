export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { resolveEntity, canReadProject, canWriteGovernance, isValidEntityType } from '@/lib/utils/flag-governance'
import { removeStoragePaths, EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'

// FEATURE (deep audit, section 13): flag_attachments had a GET (list) and
// POST (upload) but no way to remove one — a mistaken upload (wrong file,
// wrong flag, a client's evidence sent to the wrong thread) was permanent.
// Gated on the same canWriteGovernance permission as the upload itself
// (APPROVE_FLAGS or GRANT_EXCEPTIONS), not restricted to the uploader —
// this is shared governance evidence on a flag/exception multiple
// reviewers collaborate on, the same model comments already use.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ entityType: string; entityId: string; attachmentId: string }> }
) {
  try {
    const { entityType, entityId, attachmentId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isValidEntityType(entityType))
      return NextResponse.json({ error: 'Invalid entity type' }, { status: 400 })
    if (!canWriteGovernance(session))
      return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS or GRANT_EXCEPTIONS' }, { status: 403 })

    const service = createServiceClient()
    const entity = await resolveEntity(service, session.workspaceId, entityType, entityId)
    if (!entity) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, entity.projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Scope strictly by workspace_id + entity_type + entity_id — not just
    // the attachment id — so an id belonging to a different workspace's
    // (or a different entity's) attachment can never be targeted here.
    const { data: attachment } = await (service as any)
      .from('flag_attachments')
      .select('id, storage_path, file_name')
      .eq('id', attachmentId)
      .eq('workspace_id', session.workspaceId)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .single()

    if (!attachment) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })

    // Delete the DB row first: it's the source of truth for what's visible
    // to the app, so if storage cleanup below fails, the worst case is a
    // harmless orphaned object in a private bucket — never a listed
    // attachment whose download link 404s. Reuses the same best-effort,
    // logged-not-thrown removeStoragePaths() the purge crons already use
    // for this exact bucket, rather than a bare storage call.
    const { error: deleteError } = await (service as any)
      .from('flag_attachments')
      .delete()
      .eq('id', attachmentId)

    if (deleteError) throw new Error(deleteError.message)

    await removeStoragePaths(service, [attachment.storage_path], EVIDENCE_BUCKET)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'flag_attachment.removed',
      entityType: entityType === 'flag' ? 'guardian_flag' : 'exception',
      entityId, metadata: { attachment_id: attachmentId, file_name: attachment.file_name },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Flag attachment DELETE error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}
