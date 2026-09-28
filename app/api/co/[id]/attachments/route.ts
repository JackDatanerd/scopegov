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

import { randomUUID } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { ALLOWED_ATTACHMENT_TYPES as ALLOWED_TYPES, matchesDeclaredType } from '@/lib/utils/file-signature'
import { EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB — same cap as flag and SOW attachments
const MAX_ATTACHMENTS_PER_CO = 20

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders').select('id, project_id').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
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
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders').select('id, project_id, status').eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
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
    if (declaredLength > MAX_FILE_BYTES + 512 * 1024)
      return NextResponse.json({ error: 'File exceeds 10 MB limit' }, { status: 413 })

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (file.size > MAX_FILE_BYTES)
      return NextResponse.json({ error: 'File exceeds 10 MB limit' }, { status: 400 })
    if (!ALLOWED_TYPES.has(file.type))
      return NextResponse.json({ error: `Unsupported file type: ${file.type || 'unknown'}` }, { status: 400 })

    const rawExt = file.name.includes('.') ? (file.name.split('.').pop() || '') : ''
    const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin'
    const displayName = file.name.replace(/[\\/]+/g, '_').slice(0, 200) || 'attachment'
    const storagePath = `${session.workspaceId}/co/${id}/${randomUUID()}.${ext}`

    const buffer = Buffer.from(await file.arrayBuffer())
    if (!matchesDeclaredType(file.type, buffer))
      return NextResponse.json({ error: 'File content does not match its declared type' }, { status: 400 })
    const { error: uploadError } = await service.storage.from(EVIDENCE_BUCKET).upload(storagePath, buffer, {
      contentType: file.type, upsert: false,
    })
    if (uploadError) throw new Error(uploadError.message)

    const { data: attachment, error } = await (service as any)
      .from('co_attachments')
      .insert({
        co_id: id, file_name: displayName, file_size: file.size, mime_type: file.type,
        storage_path: storagePath, uploaded_by: session.id,
      })
      .select('id, uploaded_at')
      .single()

    if (error || !attachment) {
      // Roll back the orphaned object rather than leaving storage and the DB out of sync.
      await service.storage.from(EVIDENCE_BUCKET).remove([storagePath])
      throw new Error(error?.message || 'insert returned no row')
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'co_attachment.added', entityType: 'change_order', entityId: id,
      metadata: { attachment_id: attachment.id, file_name: displayName },
    })

    const { data: signed } = await service.storage.from(EVIDENCE_BUCKET).createSignedUrl(storagePath, 3600)
    return NextResponse.json({
      attachment: {
        id: attachment.id, fileName: displayName, fileSize: file.size, mimeType: file.type,
        uploadedAt: attachment.uploaded_at, uploadedByName: session.name,
        downloadUrl: signed?.signedUrl || null,
      },
    })
  } catch (err) {
    console.error('CO attachments POST error:', err)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
