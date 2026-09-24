export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

// Document numbering (SOW / change order / invoice): a per-workspace prefix and the next number.
// The counter itself lives in workspace_document_sequences and is advanced atomically by
// assign_document_number() at send time (migration 003/076). This route only ever changes it
// through set_document_sequence(), which locks that same row and refuses a next number that
// would collide with a number already issued under the same prefix.

const TYPES = ['sow', 'co', 'invoice'] as const
type DocType = typeof TYPES[number]
const DEFAULT_PREFIX: Record<DocType, string> = { sow: 'SOW', co: 'CO', invoice: 'INV' }
const LABEL: Record<DocType, string> = { sow: 'SOW', co: 'Change order', invoice: 'Invoice' }
const PREFIX_RE = /^[A-Z0-9]([A-Z0-9-]{0,10}[A-Z0-9])?$/

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })

    const service = createServiceClient()
    const { data, error } = await (service as any)
      .from('workspace_document_sequences')
      .select('document_type, prefix, next_number')
      .eq('workspace_id', session.workspaceId)
    if (error) {
      console.error('Numbering load failed:', error)
      return NextResponse.json({ error: 'Failed to load document numbering' }, { status: 500 })
    }

    const byType = new Map<string, any>((data || []).map((r: any) => [r.document_type, r]))
    return NextResponse.json({
      sequences: TYPES.map(t => {
        const row = byType.get(t)
        return {
          documentType: t,
          label: LABEL[t],
          defaultPrefix: DEFAULT_PREFIX[t],
          prefix: row?.prefix || DEFAULT_PREFIX[t],
          nextNumber: row?.next_number ?? 1,
        }
      }),
    })
  } catch (err) {
    console.error('Numbering GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    const documentType = (body as any).documentType as DocType
    if (!TYPES.includes(documentType)) return NextResponse.json({ error: 'Invalid document type' }, { status: 400 })

    const rawPrefix = (body as any).prefix
    if (rawPrefix !== undefined && rawPrefix !== null && typeof rawPrefix !== 'string')
      return NextResponse.json({ error: 'Prefix must be text' }, { status: 400 })
    const prefix = (typeof rawPrefix === 'string' ? rawPrefix.trim().toUpperCase() : '') || DEFAULT_PREFIX[documentType]
    if (!PREFIX_RE.test(prefix))
      return NextResponse.json({ error: 'Prefix can use letters, numbers and hyphens (up to 12 characters) and must start and end with a letter or number.' }, { status: 400 })

    const rawNext = (body as any).nextNumber
    const nextNumber = typeof rawNext === 'number' ? rawNext : Number(String(rawNext ?? '').trim())
    if (!Number.isInteger(nextNumber) || nextNumber < 1 || nextNumber > 99999999)
      return NextResponse.json({ error: 'Next number must be a whole number from 1 to 99,999,999' }, { status: 400 })

    const service = createServiceClient()

    const { data: before } = await (service as any)
      .from('workspace_document_sequences')
      .select('prefix, next_number')
      .eq('workspace_id', session.workspaceId).eq('document_type', documentType).maybeSingle()

    const { error } = await (service as any).rpc('set_document_sequence', {
      p_workspace_id: session.workspaceId,
      p_document_type: documentType,
      p_prefix: prefix,
      p_next_number: nextNumber,
    })
    if (error) {
      const msg = String(error.message || '')
      const tooLow = msg.match(/next_number_too_low:(\d+)/)
      if (tooLow) {
        return NextResponse.json({
          error: `${prefix}-${String(Number(tooLow[1])).padStart(4, '0')} or higher is the earliest number you can use — ${prefix} numbers up to ${Number(tooLow[1]) - 1} have already been issued and a number can't be used twice.`,
          minimum: Number(tooLow[1]),
        }, { status: 409 })
      }
      console.error('set_document_sequence failed:', error)
      return NextResponse.json({ error: 'Failed to update document numbering' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.numbering_updated', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: {
        documentType,
        from: { prefix: before?.prefix || DEFAULT_PREFIX[documentType], nextNumber: before?.next_number ?? 1 },
        to:   { prefix, nextNumber },
      },
    })

    return NextResponse.json({ ok: true, documentType, prefix, nextNumber })
  } catch (err) {
    console.error('Numbering PUT error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
