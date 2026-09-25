export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'

// FEATURE (independent pass round 2, section 13): pairs with guardian/inbound now saving the
// actual bytes of an inbound email's attachments (guardian_check_attachments / migration 085)
// instead of only the filename. The missing read surface for those files — signed, short-lived
// download URLs, same pattern as GET /api/scope-governance/.../attachments.
//
// Gated the same way GET /api/guardian/flags/[id] gates its "original request" panel — any
// permission that lets someone review or act on a flag/check — rather than ACCESS_GUARDIAN_HISTORY
// alone: a check's attachments should be visible from the flag it raised (viewed by an
// APPROVE_FLAGS/GRANT_EXCEPTIONS/CREATE_CHANGE_ORDERS holder who may not have the separate history
// permission) just as much as from the check-history panel itself.
const SOURCE_VIEW_PERMISSIONS = ['APPROVE_FLAGS', 'GRANT_EXCEPTIONS', 'CREATE_CHANGE_ORDERS', 'ACCESS_GUARDIAN_HISTORY'] as const

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: checkId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!SOURCE_VIEW_PERMISSIONS.some(p => hasPermission(session, p)))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: check } = await (service as any).from('guardian_checks')
      .select('id, project_id').eq('id', checkId).eq('workspace_id', session.workspaceId).single()
    if (!check) return NextResponse.json({ error: 'Check not found' }, { status: 404 })
    if (!(await canReadProject(service, session, check.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: rows, error } = await (service as any).from('guardian_check_attachments')
      .select('id, file_name, file_size, mime_type, storage_path, created_at')
      .eq('check_id', checkId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)

    // Bucket is private — hand back short-lived signed URLs, resolved in parallel (same pattern
    // as the flag/exception evidence GET).
    const attachments = await Promise.all((rows || []).map(async (a: any) => {
      const { data: signed } = await service.storage.from(EVIDENCE_BUCKET).createSignedUrl(a.storage_path, 3600)
      return {
        id: a.id, fileName: a.file_name, fileSize: a.file_size, mimeType: a.mime_type,
        createdAt: a.created_at, downloadUrl: signed?.signedUrl || null,
      }
    }))

    return NextResponse.json({ attachments })
  } catch (err) {
    console.error('Guardian check attachments GET error:', err)
    return NextResponse.json({ error: 'Could not load attachments' }, { status: 500 })
  }
}
