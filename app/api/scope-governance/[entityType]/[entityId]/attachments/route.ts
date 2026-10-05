export const runtime = 'nodejs'

import { randomUUID } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, MAX_UPLOAD_REQUEST_BYTES } from '@/lib/utils/upload-limits'
import { getSession } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { stripUnstorableText, truncateText } from '@/lib/utils/sanitize'
import { resolveEntity, canReadProject, canWriteGovernance, canViewGovernance, isValidEntityType } from '@/lib/utils/flag-governance'
// FIX (independent pass round 2, section 13): the allowlist + magic-byte check used to live only
// here, hand-typed; guardian/inbound's saved email attachments now need the exact same validation,
// so it's factored out into one shared implementation (see lib/utils/file-signature.ts for why).
import { ALLOWED_ATTACHMENT_TYPES as ALLOWED_TYPES, matchesDeclaredType, resolveAttachmentType } from '@/lib/utils/file-signature'

// Private bucket, created manually in the Supabase dashboard (same as the
// existing `pdfs` bucket) — see README §1.2 for setup. Never public: this
// is client-submitted evidence and signed addenda, not brand assets.
const BUCKET = 'flag-evidence'
export const MAX_ATTACHMENTS_PER_ENTITY = 25
const MAX_FILE_BYTES = MAX_UPLOAD_BYTES // see lib/utils/upload-limits.ts (Vercel's 4.5 MB request-body limit)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ entityType: string; entityId: string }> }
) {
  try {
    const { entityType, entityId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!canViewGovernance(session))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!isValidEntityType(entityType))
      return NextResponse.json({ error: 'Invalid entity type' }, { status: 400 })

    const service = createServiceClient()
    const entity = await resolveEntity(service, session.workspaceId, entityType, entityId)
    if (!entity) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, entity.projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: attachments, error: attachmentsErr } = await (service as any)
      .from('flag_attachments')
      .select('id, file_name, file_size, mime_type, storage_path, uploaded_at, uploaded_by, users!flag_attachments_uploaded_by_fkey(name)')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('uploaded_at', { ascending: false })
    // FIX (independent pass 2, section 13 - G4): a failed read answered 200 with no attachments - evidence looked
    // missing/deleted. Fail loudly instead.
    if (attachmentsErr) throw new Error(`flag_attachments read failed: ${attachmentsErr.message}`)

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

    // FIX (Guardian section 13, pass 14 - B7): nothing bounded how many files one flag/exception could hold (the SOW and CO
    // attachment routes already cap theirs), so evidence storage could grow without limit. Fail open on a count error.
    const { count: existingCount, error: countErr } = await (service as any)
      .from('flag_attachments').select('id', { count: 'exact', head: true })
      .eq('entity_type', entityType).eq('entity_id', entityId)
    if (!countErr && (existingCount || 0) >= MAX_ATTACHMENTS_PER_ENTITY)
      return NextResponse.json({ error: `A ${entityType} can have at most ${MAX_ATTACHMENTS_PER_ENTITY} attachments.` }, { status: 400 })

    // request.formData() buffers the whole body before the size check below can run — refuse an
    // obviously oversized upload up front (allowing for multipart overhead).
    const declaredLength = Number(request.headers.get('content-length') || 0)
    if (declaredLength > MAX_UPLOAD_REQUEST_BYTES)
      return NextResponse.json({ error: `File exceeds ${MAX_UPLOAD_LABEL} limit` }, { status: 413 })

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    // Browsers send an empty File.type for some extensions (.eml on Chrome/Windows) — see resolveAttachmentType.
    const fileType = resolveAttachmentType(file.name, file.type)
    if (file.size > MAX_FILE_BYTES)
      return NextResponse.json({ error: `File exceeds ${MAX_UPLOAD_LABEL} limit` }, { status: 400 })
    if (!ALLOWED_TYPES.has(fileType))
      return NextResponse.json({ error: `Unsupported file type: ${fileType || 'unknown'}` }, { status: 400 })

    // FIX (independent pass, section 13): the extension came straight from the client's filename
    // (and a name with no dot returned the WHOLE name), so slashes/spaces/unicode/'?'/'#' ended up
    // in the storage object key — Supabase rejects some, turning an ordinary upload into a 500.
    // Only [a-z0-9] survives; the display name is length-capped and stripped of path separators.
    const rawExt = file.name.includes('.') ? (file.name.split('.').pop() || '') : ''
    const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin'
    // FIX (Guardian section 13, independent pass 7 - B2): `.slice(0, 200)` could cut an emoji in half, and a lone
    // surrogate (or a NUL) in file_name fails the whole insert - an ordinary upload turned into "Upload failed" (the
    // stored object is rolled back). truncateText never splits a pair; stripUnstorableText repairs what the browser sent.
    const displayName = truncateText(stripUnstorableText(file.name.replace(/[\\/]+/g, '_')), 200).trim() || 'attachment'
    const storagePath = `${session.workspaceId}/${entityType}/${entityId}/${randomUUID()}.${ext}`

    const buffer = Buffer.from(await file.arrayBuffer())
    if (!matchesDeclaredType(fileType, buffer)) {
      return NextResponse.json({ error: 'File content does not match its declared type' }, { status: 400 })
    }
    const { error: uploadError } = await service.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: fileType, upsert: false,
    })
    if (uploadError) throw new Error(uploadError.message)

    const { data: attachment, error } = await (service as any)
      .from('flag_attachments')
      .insert({
        workspace_id: session.workspaceId,
        project_id: entity.projectId,
        entity_type: entityType,
        entity_id: entityId,
        file_name: displayName,
        file_size: file.size,
        mime_type: fileType,
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
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'flag_attachment.added',
      entityType: entityType === 'flag' ? 'guardian_flag' : 'exception',
      entityId, metadata: { attachment_id: attachment.id, file_name: displayName },
    })

    // FIX (independent pass, section 13): same class of bug already fixed on the comments route —
    // uploading evidence didn't touch the flag's updated_at, so cron/guardian-flag-stall (which
    // measures inactivity by updated_at) kept nagging about flags someone had just acted on.
    if (entityType === 'flag') {
      const { error: touchErr } = await (service as any).from('guardian_flags')
        .update({ updated_at: new Date().toISOString() }).eq('id', entityId)
      if (touchErr) console.error('Could not bump flag activity timestamp:', touchErr.message)
    }

    const { data: signed } = await service.storage.from(BUCKET).createSignedUrl(storagePath, 3600)

    return NextResponse.json({
      attachment: {
        id: attachment.id, fileName: displayName, fileSize: file.size, mimeType: fileType,
        uploadedAt: attachment.uploaded_at, uploadedByName: session.name,
        downloadUrl: signed?.signedUrl || null,
      },
    })
  } catch (err) {
    console.error('Flag attachments POST error:', err)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
