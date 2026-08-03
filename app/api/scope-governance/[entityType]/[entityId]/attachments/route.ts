export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { resolveEntity, canReadProject, canWriteGovernance, isValidEntityType } from '@/lib/utils/flag-governance'

// Private bucket, created manually in the Supabase dashboard (same as the
// existing `pdfs` bucket) — see README §1.2 for setup. Never public: this
// is client-submitted evidence and signed addenda, not brand assets.
const BUCKET = 'flag-evidence'
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
const ALLOWED_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
  'message/rfc822', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ entityType: string; entityId: string }> }
) {
  try {
    const { entityType, entityId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isValidEntityType(entityType))
      return NextResponse.json({ error: 'Invalid entity type' }, { status: 400 })

    const service = createServiceClient()
    const entity = await resolveEntity(service, session.workspaceId, entityType, entityId)
    if (!entity) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, entity.projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: attachments } = await (service as any)
      .from('flag_attachments')
      .select('id, file_name, file_size, mime_type, storage_path, uploaded_at, uploaded_by, users!flag_attachments_uploaded_by_fkey(name)')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('uploaded_at', { ascending: false })

    // Bucket is private — hand back short-lived signed URLs rather than
    // public ones, resolved in parallel.
    const withUrls = await Promise.all((attachments || []).map(async (a: any) => {
      const { data: signed } = await service.storage.from(BUCKET).createSignedUrl(a.storage_path, 3600)
      return {
        id: a.id, fileName: a.file_name, fileSize: a.file_size, mimeType: a.mime_type,
        uploadedAt: a.uploaded_at, uploadedByName: a.users?.name || 'Unknown',
        downloadUrl: signed?.signedUrl || null,
      }
    }))

    return NextResponse.json({ attachments: withUrls })
  } catch (err) {
    console.error('Flag attachments GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ entityType: string; entityId: string }> }
) {
  try {
    const { entityType, entityId } = await params
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

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (file.size > MAX_FILE_BYTES)
      return NextResponse.json({ error: 'File exceeds 10 MB limit' }, { status: 400 })
    if (!ALLOWED_TYPES.has(file.type))
      return NextResponse.json({ error: `Unsupported file type: ${file.type || 'unknown'}` }, { status: 400 })

    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().slice(0, 10)
    const storagePath = `${session.workspaceId}/${entityType}/${entityId}/${crypto.randomUUID()}.${ext}`

    const buffer = Buffer.from(await file.arrayBuffer())
    const { error: uploadError } = await service.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: file.type, upsert: false,
    })
    if (uploadError) throw new Error(uploadError.message)

    const { data: attachment, error } = await (service as any)
      .from('flag_attachments')
      .insert({
        workspace_id: session.workspaceId,
        project_id: entity.projectId,
        entity_type: entityType,
        entity_id: entityId,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
        storage_path: storagePath,
        uploaded_by: session.id,
      })
      .select('id, uploaded_at')
      .single()

    if (error) {
      // Roll back the orphaned object rather than leaving storage and the
      // DB out of sync.
      await service.storage.from(BUCKET).remove([storagePath])
      throw new Error(error.message)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'flag_attachment.added',
      entityType: entityType === 'flag' ? 'guardian_flag' : 'exception',
      entityId, metadata: { attachment_id: attachment.id, file_name: file.name },
    })

    const { data: signed } = await service.storage.from(BUCKET).createSignedUrl(storagePath, 3600)

    return NextResponse.json({
      attachment: {
        id: attachment.id, fileName: file.name, fileSize: file.size, mimeType: file.type,
        uploadedAt: attachment.uploaded_at, uploadedByName: session.name,
        downloadUrl: signed?.signedUrl || null,
      },
    })
  } catch (err) {
    console.error('Flag attachments POST error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}
