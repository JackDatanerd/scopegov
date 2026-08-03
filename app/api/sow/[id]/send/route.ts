export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sendSowDocument } from '@/lib/documents/send-sow'
import { evaluateApprovalGate } from '@/lib/approvals/engine'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_SOW'))
      return NextResponse.json({ error: 'Missing permission: SEND_SOW' }, { status: 403 })

    // Email must be verified to send (spec §16.0)
    if (!session.emailVerifiedAt)
      return NextResponse.json({ error: 'Please verify your email before sending SOWs' }, { status: 403 })

    const service = createServiceClient()

    // Fetch just enough to run the approval gate before touching send
    // mechanics — full fetch + document numbering + JWT issuance happens
    // inside sendSowDocument (lib/documents/send-sow.ts).
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, status, project_id,
        projects(id, name, disc, contract_value, currency)`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    if (sow.status !== 'draft')
      return NextResponse.json({ error: 'Only draft SOWs can be sent' }, { status: 400 })

    const project = sow.projects
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Phase 3 — Approval Chains: if a workflow matches this SOW's contract
    // value, halt here and wait on sign-off instead of sending. The
    // document stays 'draft' (and un-numbered — Phase 0 only assigns a
    // document number once send actually happens); approvers act via
    // /api/approvals/[id]/approve and the engine sends it automatically
    // once the chain clears.
    const gate = await evaluateApprovalGate(service, {
      workspaceId:  session.workspaceId,
      documentType: 'sow',
      documentId:   id,
      projectId:    project.id,
      projectName:  project.name,
      amount:       project.contract_value || 0,
      currency:     project.currency || 'USD',
      documentTitle: `SOW v${sow.version} — ${project.name}`,
      requestedBy:  { id: session.id, name: session.name, email: session.email },
    })

    if (gate.requiresApproval) {
      return NextResponse.json({
        ok: true,
        pendingApproval: true,
        approvalRequestId: gate.approvalRequestId,
        message: 'Sent for approval — the client will be notified once it clears.',
      })
    }

    const result = await sendSowDocument(service, {
      sowId: id,
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
    })

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, token: result.token, portalUrl: result.portalUrl, documentNumber: result.documentNumber })
  } catch (err) {
    console.error('SOW send error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
