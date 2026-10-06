export const runtime = 'nodejs'

// GET/POST /api/co/[id]/attachments
//
// FEATURE (CO logic audit — gap): co_attachments (migration 001) has been a fully-defined table since day one, and
// lib/utils/storage-cleanup.ts already purges its rows and Storage objects, but nothing ever wrote a row: an agency
// had no way to attach the client's email, a mockup or a revised brief to the change order it justifies. SOW got
// exactly this in its own lifecycle pass; this is the CO counterpart, reusing the same private bucket, type
// allowlist, magic-byte check and short-lived signed URLs.
//
// Attachments are internal working material for the agency (they are NOT shown in the client portal or the PDF), and
// like SOW attachments they can only change while the CO is an editable draft with no approval in flight.

import { isUuidString } from '@/lib/utils/uuid'
import { randomUUID } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { lookupMissResponse } from '@/lib/documents/co-lookup'
import { NextResponse, type NextRequest } from 'next/server'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, MAX_UPLOAD_REQUEST_BYTES } from '@/lib/utils/upload-limits'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { ALLOWED_ATTACHMENT_TYPES as ALLOWED_TYPES, matchesDeclaredType, resolveAttachmentType } from '@/lib/utils/file-signature'
import { EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'
import { stripUnstorableText, truncateText } from '@/lib/utils/sanitize'

const MAX_FILE_BYTES = MAX_UPLOAD_BYTES // see lib/utils/upload-limits.ts (Vercel's 4.5 MB request-body limit)
const MAX_ATTACHMENTS_PER_CO = 20

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const service = createServiceClient()
    const { data: co, error: coLookupErr } = await (service as any)
      .from('change_orders').select('id, project_id').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!co) return lookupMissResponse(coLookupErr, 'Not found')
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: attachments } = await (service as any)
      .from('co_attachments')
      .select('id, file_name, file_size, mime_type, storage_path, uploaded_at, uploaded_by, users!co_attachments_uploaded_by_fkey(name)')
      .eq('co_id', id)
      .order('uploaded_at', { ascending: false })

    const withUrls = await Promise.all((attachments || []).map(async (a: any) => {
      const { data: signed } = await service.storage.from(EVIDENCE_BUCKET).createSignedUrl(a.storage_path, 3600)
      return {
        id: a.id, fileName: a.file_name, fileSize: a.file_size, mimeType: a.mime_type,
        uploadedAt: a.uploaded_at, uploadedByName: a.users?.name || 'Unknown',
        downloadUrl: signed?.signedUrl || null,
      }
    }))

    return NextResponse.json({ attachments: withUrls })
  } catch (err) {
    console.error('CO attachments GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

    const service = createServiceClient()
    const { data: co, error: coLookupErr } = await (service as any)
      .from('change_orders').select('id, project_id, status').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!co) return lookupMissResponse(coLookupErr, 'Not found')
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (co.status !== 'draft')
      return NextResponse.json({ error: 'This change order is locked — attachments can only be added to a draft.' }, { status: 409 })
    if (await getPendingApprovalForDocument(service, 'co', id))
      return NextResponse.json({ error: 'This change order has a pending approval request — cancel it before changing attachments.' }, { status: 409 })

    const { count } = await (service as any)
      .from('co_attachments').select('id', { count: 'exact', head: true }).eq('co_id', id)
    if ((count || 0) >= MAX_ATTACHMENTS_PER_CO)
      return NextResponse.json({ error: `A change order can have at most ${MAX_ATTACHMENTS_PER_CO} attachments.` }, { status: 400 })

    // request.formData() buffers the whole body before the size check below can run — refuse an obviously
    // oversized upload up front (allowing for multipart overhead).
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

    const rawExt = file.name.includes('.') ? (file.name.split('.').pop() || '') : ''
    const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin'
    const displayName = truncateText(stripUnstorableText(file.name).replace(/[\\/]+/g, '_'), 200) || 'attachment'
    const storagePath = `${session.workspaceId}/co/${id}/${randomUUID()}.${ext}`

    const buffer = Buffer.from(await file.arrayBuffer())
    if (!matchesDeclaredType(fileType, buffer))
      return NextResponse.json({ error: 'File content does not match its declared type' }, { status: 400 })
    const { error: uploadError } = await service.storage.from(EVIDENCE_BUCKET).upload(storagePath, buffer, {
      contentType: fileType, upsert: false,
    })
    if (uploadError) throw new Error(uploadError.message)

    // CO-6: the cap, the draft lock and the approval lock are re-checked atomically inside co_attachment_add (migration 148),
    // under a row lock on the change order - the pre-checks above are only a fast path, they cannot stop two concurrent
    // uploads (or an upload racing a send) from both getting through.
    const { data: added, error } = await (service as any).rpc('co_attachment_add', {
      p_co_id: id,
      p_file_name: displayName,
      p_file_size: file.size,
      p_mime_type: fileType,
      p_storage_path: storagePath,
      p_uploaded_by: session.id,
    })

    if (error || !added) {
      // Roll back the orphaned object rather than leaving storage and the DB out of sync.
      const { error: rollbackError } = await service.storage.from(EVIDENCE_BUCKET).remove([storagePath])
      if (rollbackError) console.error('Could not roll back CO attachment object after failed insert:', rollbackError.message)
      const msg = String(error?.message || '')
      if (msg.includes('attachment_limit_exceeded'))
        return NextResponse.json({ error: `A change order can have at most ${MAX_ATTACHMENTS_PER_CO} attachments.` }, { status: 400 })
      if (msg.includes('co_locked'))
        return NextResponse.json({ error: 'This change order is locked — attachments can only be added to a draft.' }, { status: 409 })
      if (msg.includes('co_approval_pending'))
        return NextResponse.json({ error: 'This change order has a pending approval request — cancel it before changing attachments.' }, { status: 409 })
      if (msg.includes('co_not_found'))
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      throw new Error(error?.message || 'co_attachment_add returned no row')
    }
    const attachment = { id: added.id as string, uploaded_at: added.uploaded_at as string }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'co_attachment.added', entityType: 'change_order', entityId: id,
      metadata: { attachment_id: attachment.id, file_name: displayName },
    })

    const { data: signed } = await service.storage.from(EVIDENCE_BUCKET).createSignedUrl(storagePath, 3600)
    return NextResponse.json({
      attachment: {
        id: attachment.id, fileName: displayName, fileSize: file.size, mimeType: fileType,
        uploadedAt: attachment.uploaded_at, uploadedByName: session.name,
        downloadUrl: signed?.signedUrl || null,
      },
    })
  } catch (err) {
    console.error('CO attachments POST error:', err)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
