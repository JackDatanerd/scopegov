import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id, status, sent_at, sections')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })

    // Lock check — sentAt makes document permanently read-only (spec §0.6)
    if (sow.sent_at)
      return NextResponse.json({ error: 'SOW is locked after sending. Withdraw to edit.' }, { status: 409 })

    const body = await request.json()

    // Can update full sections array or a single section
    let newSections = sow.sections || []
    if (body.sections) {
      newSections = body.sections
    } else if (body.sectionId && body.content !== undefined) {
      newSections = newSections.map((s: any) =>
        s.id === body.sectionId ? { ...s, content: body.content } : s
      )
    } else if (body.sectionId && body.visible !== undefined) {
      newSections = newSections.map((s: any) =>
        s.id === body.sectionId ? { ...s, visible: body.visible } : s
      )
    }

    const { error } = await (service as any)
      .from('sow_documents')
      .update({ sections: newSections, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select('id, version, status, sent_at, signed_at, sections, metadata, expires_at, token')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ sow })
  } catch {
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}
