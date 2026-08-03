export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { cancelApprovalRequest } from '@/lib/approvals/engine'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: req } = await (service as any)
      .from('approval_requests')
      .select('id, requested_by, status, document_type, document_id')
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!req) return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
    if (req.status !== 'pending')
      return NextResponse.json({ error: 'Only a pending request can be cancelled' }, { status: 400 })
    if (req.requested_by !== session.id && !hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Only the requester or an admin can cancel this' }, { status: 403 })

    await cancelApprovalRequest(service, {
      documentType: req.document_type, documentId: req.document_id,
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      reason: 'Cancelled by requester',
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
