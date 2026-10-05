export const runtime = 'nodejs'

// GET/POST /api/sow/[id]/attachments
//
// FIX (section-9 audit, fresh independent pass — feature gap): sow_attachments
// (migration 001) has been a fully-defined table since day one — file_name,
// file_size, mime_type, storage_path, uploaded_by, uploaded_at — and
// lib/utils/storage-cleanup.ts has known how to purge its rows and Storage
// objects (through the flag-evidence bucket, alongside co_attachments/
// flag_attachments) since that file was written. But nothing ever wrote a
// row to it: no route, no UI. An agency had no way to attach supporting
// material — a signed brief, reference mockups, a client's own scope doc —
// to a SOW anywhere in the product. This is that route; the UI lives in
// SowEditor's sidebar.
//
// Reuses the exact bucket, allowlist, magic-byte check and storage-path
// shape already established for flag/exception evidence
// (app/api/scope-governance/[entityType]/[entityId]/attachments/route.ts) —
// same private-bucket-plus-signed-URL model, just scoped to a SOW instead of
// a Guardian flag. See that route's own comments for why each check exists.
//
// FIX (section-9 independent pass): the 20-attachment cap and the draft-only lock were plain
// read-then-insert checks, so concurrent uploads could exceed the cap and an upload racing a send
// could land on a locked SOW. The insert now goes through sow_attachment_add (migration 109),
// which rechecks both under a row lock; the pre-checks below remain only as a cheap fast-path.

import { isUuidString } from '@/lib/utils/uuid'
import { randomUUID } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, MAX_UPLOAD_REQUEST_BYTES } from '@/lib/utils/upload-limits'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { ALLOWED_ATTACHMENT_TYPES as ALLOWED_TYPES, matchesDeclaredType, resolveAttachmentType } from '@/lib/utils/file-signature'
import { EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'
import { truncateText } from '@/lib/utils/sanitize'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'

const MAX_FILE_BYTES = MAX_UPLOAD_BYTES // see lib/utils/upload-limits.ts (Vercel's 4.5 MB request-body limit)
const MAX_ATTACHMENTS_PER_SOW = 20

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents').select('id, project_id').eq('id', id)
      .eq('workspace_id', session.workspaceId).single()
    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: attachments } = await (service as any)
      .from('sow_attachments')
      .select('id, file_name, file_size, mime_type, storage_path, uploaded_at, uploaded_by, users!sow_attachments_uploaded_by_fkey(name)')
      .eq('sow_id', id)
      .order('uploaded_at', { ascending: false })

    // Bucket is private — hand back short-lived signed URLs, same as the
    // flag-evidence route this is modeled on.
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
    console.error('SOW attachments GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents').select('id, project_id, sent_at').eq('id', id)
      .eq('workspace_id', session.workspaceId).single()
    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    // Same "locked after sending" boundary SowEditor already enforces for
    // section content — attachments are part of the working draft, not
    // something to keep silently mutating once a document is out for
    // signature (or signed, declined, withdrawn, expired).
    if (sow.sent_at) return NextResponse.json({ error: 'SOW is locked — attachments can only be added to a draft.' }, { status: 409 })
    // FIX (section-11 audit, pass 1 — B1): a SOW inside an approval chain (or approved but not yet sent)
    // is still status 'draft', so the sent_at check above never applied. Approvers sign off on a snapshot of
    // the document; changing its attachments underneath them means the SOW that goes out is not the one
    // that was approved. Same lock the CO attachment route, SOW PATCH, generate and regenerate-section apply.
    if (await getPendingApprovalForDocument(service, 'sow', id))
      return NextResponse.json({ error: 'This SOW has a pending approval request — cancel it before changing attachments.' }, { status: 409 })

    const { count } = await (service as any)
      .from('sow_attachments').select('id', { count: 'exact', head: true }).eq('sow_id', id)
    if ((count || 0) >= MAX_ATTACHMENTS_PER_SOW)
      return NextResponse.json({ error: `A SOW can have at most ${MAX_ATTACHMENTS_PER_SOW} attachments.` }, { status: 400 })

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

    const rawExt = file.name.includes('.') ? (file.name.split('.').pop() || '') : ''
    const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin'
    const displayName = truncateText(file.name.replace(/[\\/]+/g, '_'), 200) || 'attachment'
    const storagePath = `${session.workspaceId}/sow/${id}/${randomUUID()}.${ext}`

    const buffer = Buffer.from(await file.arrayBuffer())
    if (!matchesDeclaredType(fileType, buffer)) {
      return NextResponse.json({ error: 'File content does not match its declared type' }, { status: 400 })
    }
    const { error: uploadError } = await service.storage.from(EVIDENCE_BUCKET).upload(storagePath, buffer, {
      contentType: fileType, upsert: false,
    })
    if (uploadError) throw new Error(uploadError.message)

    // Cap + draft-lock (+ the active-approval lock, migration 117) are re-checked atomically inside sow_attachment_add (migration 109), under a
    // row lock on the SOW — the pre-checks above are only a fast-path, they can't stop two
    // concurrent uploads (or an upload racing a send) from both getting through.
    const { data: added, error } = await (service as any).rpc('sow_attachment_add', {
      p_sow_id: id,
      p_file_name: displayName,
      p_file_size: file.size,
      p_mime_type: fileType,
      p_storage_path: storagePath,
      p_uploaded_by: session.id,
    })

    if (error || !added) {
      // Roll back the orphaned object rather than leaving storage and the
      // DB out of sync.
      const { error: rollbackError } = await service.storage.from(EVIDENCE_BUCKET).remove([storagePath])
      if (rollbackError) console.error('Could not roll back SOW attachment object after failed insert:', rollbackError.message)
      const msg = String(error?.message || '')
      if (msg.includes('attachment_limit_exceeded'))
        return NextResponse.json({ error: `A SOW can have at most ${MAX_ATTACHMENTS_PER_SOW} attachments.` }, { status: 400 })
      if (msg.includes('sow_locked'))
        return NextResponse.json({ error: 'SOW is locked — attachments can only be added to a draft.' }, { status: 409 })
      if (msg.includes('sow_approval_pending'))
        return NextResponse.json({ error: 'This SOW has a pending approval request — cancel it before changing attachments.' }, { status: 409 })
      if (msg.includes('sow_not_found'))
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      throw new Error(error?.message || 'sow_attachment_add returned no row')
    }
    const attachment = { id: added.id as string, uploaded_at: added.uploaded_at as string }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'sow_attachment.added', entityType: 'sow', entityId: id,
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
    console.error('SOW attachments POST error:', err)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
