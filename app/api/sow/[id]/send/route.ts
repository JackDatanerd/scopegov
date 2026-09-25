export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sendSowDocument } from '@/lib/documents/send-sow'
import { evaluateApprovalGate } from '@/lib/approvals/engine'
import { sendBlockedReason } from '@/lib/documents/preflight'
import { canReadProject } from '@/lib/utils/project-access'
import { validateSowForSend } from '@/lib/sow/validate-send'

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
      .select(`id, version, status, project_id, sections, metadata,
        projects(id, name, disc, contract_value, currency)`)
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (sow.status !== 'draft')
      return NextResponse.json({ error: 'Only draft SOWs can be sent' }, { status: 400 })

    const project = sow.projects
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Everything that must hold before a SOW reaches a client lives in lib/sow/validate-send.ts
    // (shared with the approval-chain auto-send, which used to skip all of it).
    const body = await request.json().catch(() => ({} as any))
    const validation = validateSowForSend({
      sections: sow.sections, metadata: sow.metadata, contractValue: project.contract_value,
    })
    if (validation.errors.length > 0)
      return NextResponse.json({ error: validation.errors[0], errors: validation.errors }, { status: 400 })
    const acknowledged = body?.acknowledgeWarnings === true
    if (validation.warnings.length > 0 && !acknowledged)
      return NextResponse.json({
        error: validation.warnings[0], warnings: validation.warnings, needsAcknowledgement: true,
      }, { status: 409 })

    // Refuse before creating an approval request for a send that can never happen.
    const blockedReason = await sendBlockedReason(service, project.id)
    if (blockedReason) return NextResponse.json({ error: blockedReason }, { status: 400 })

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
      // FIX (independent pass 3): so the requester's chosen expiry survives an approval
      // gate instead of silently reverting to the 30-day default on auto-send.
      expiresInDays: body?.expiresInDays,
    })

    // FIX (section-11 audit, pass 2): the gate can now REFUSE (nobody able to
    // approve, an approved-but-unsent request already exists, a workflow with
    // no approvers). Never proceed to a send in that case.
    if (gate.blocked) {
      return NextResponse.json({ error: gate.error, approvalRequestId: gate.approvalRequestId }, { status: gate.status || 409 })
    }

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
      enforceWarnings: true, acknowledgeWarnings: acknowledged,
      expiresInDays: body?.expiresInDays,
    })

    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.warnings ? { warnings: result.warnings, needsAcknowledgement: true } : {}) }, { status: result.status })
    return NextResponse.json({
      ok: true, token: result.token, portalUrl: result.portalUrl, documentNumber: result.documentNumber,
      emailSent: result.emailSent, ...(result.emailError ? { emailError: result.emailError } : {}),
    })
  } catch (err) {
    console.error('SOW send error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
