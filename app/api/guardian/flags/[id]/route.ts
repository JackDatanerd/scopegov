import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sanitizePlainText } from '@/lib/utils/sanitize'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body    = await request.json()
    const { action, projectId, reason, escalateTo, escalationNote } = body
    const service = createServiceClient()
    const now     = new Date().toISOString()

    const { data: flag } = await (service as any)
      .from('guardian_flags')
      .select('id,status,project_id,description,severity,sow_reference,change_order_id')
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!flag) return NextResponse.json({ error: 'Flag not found' }, { status: 404 })

    switch (action) {
      case 'resolve': {
        if (!hasPermission(session, 'APPROVE_FLAGS'))
          return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS' }, { status: 403 })
        await (service as any).from('guardian_flags').update({
          status: 'resolved', resolution: 'closed',
          resolved_by: session.id, resolved_at: now, updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name,
          eventType: 'flag.resolved', entityType: 'guardian_flag',
          entityId: id, entityName: flag.project_id, metadata: {},
        })
        break
      }

      case 'close': {
        if (!hasPermission(session, 'APPROVE_FLAGS'))
          return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS' }, { status: 403 })
        await (service as any).from('guardian_flags').update({
          status: 'closed', resolution: 'closed', close_reason: reason || null,
          resolved_by: session.id, resolved_at: now, updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name,
          eventType: 'flag.closed', entityType: 'guardian_flag', entityId: id,
          entityName: flag.project_id, metadata: { reason },
        })
        break
      }

      case 'exception': {
        if (!hasPermission(session, 'GRANT_EXCEPTIONS'))
          return NextResponse.json({ error: 'Missing permission: GRANT_EXCEPTIONS' }, { status: 403 })
        const { estimatedValue, grantedWhat, exceptionReason } = body
        await (service as any).from('exceptions_log').insert({
          project_id:   flag.project_id,
          workspace_id: session.workspaceId,
          flag_id:      id,
          deliverable:  flag.sow_reference,
          granted_what: grantedWhat || flag.description,
          granted_by:   session.id,
          estimated_value: parseFloat(estimatedValue) || 0,
          reason:       exceptionReason || reason || '',
        })
        await (service as any).from('guardian_flags').update({
          status: 'resolved', resolution: 'exception',
          resolved_by: session.id, resolved_at: now, updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name,
          eventType: 'flag.exception_granted', entityType: 'guardian_flag', entityId: id,
          entityName: flag.project_id, metadata: { estimated_value: estimatedValue },
        })
        break
      }

      case 'escalate': {
        // FIX (audit round 2, item #5): every other case in this switch
        // (resolve, close, exception, draft_co, confirm_out_of_scope) is
        // gated behind a permission check — escalate was the one
        // exception, letting any authenticated session member (any role)
        // trigger it. Match the sibling 'resolve'/'close' actions.
        if (!hasPermission(session, 'APPROVE_FLAGS'))
          return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS' }, { status: 403 })
        if (!escalationNote || escalationNote.length < 10)
          return NextResponse.json({ error: 'Escalation note must be at least 10 characters' }, { status: 400 })

        // FIX (audit round 2, item #5): escalateTo was never checked
        // against workspace membership — resolve it scoped to this
        // workspace, falling back to self-assignment if it doesn't
        // resolve to an active member here, same treatment as
        // co/[id]/escalate.
        let resolvedEscalateTo: string | null = null
        if (escalateTo) {
          const { data: member } = await (service as any)
            .from('workspace_members')
            .select('user_id')
            .eq('workspace_id', session.workspaceId)
            .eq('user_id', escalateTo)
            .eq('status', 'active')
            .single()
          if (member) resolvedEscalateTo = member.user_id
        }
        const safeNote = sanitizePlainText(escalationNote)

        // Spec §6.3: escalation NEVER changes status — it is an overlay
        await (service as any).from('guardian_flags').update({
          escalated_to:    resolvedEscalateTo || session.id,
          escalation_note: safeNote,
          updated_at:      now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name,
          eventType: 'flag.escalated', entityType: 'guardian_flag', entityId: id,
          entityName: flag.project_id, metadata: { escalated_to: resolvedEscalateTo, note: safeNote },
        })
        break
      }

      case 'draft_co': {
        if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
          return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })
        // Create CO draft pre-filled from flag (spec §6.2)
        const { data: co } = await (service as any).from('change_orders').insert({
          project_id:   flag.project_id,
          workspace_id: session.workspaceId,
          flag_id:      id,
          title:        `Change Order — ${flag.sow_reference}`,
          status:       'draft',
          line_items:   JSON.stringify([{
            id:          crypto.randomUUID(),
            description: flag.description,
            quantity:    1,
            rate:        0,
            total:       0,
          }]),
          subtotal:     0,
          total:        0,
          created_by:   session.id,
        }).select('id').single()

        if (co) {
          await (service as any).from('guardian_flags').update({
            status:         'converted_to_co',
            change_order_id: co.id,
            updated_at:     now,
          }).eq('id', id)
          await logAudit(service, {
            workspaceId: session.workspaceId, actorId: session.id,
            actorEmail: session.email, actorName: session.name,
            eventType: 'flag.converted_to_co', entityType: 'guardian_flag', entityId: id,
            entityName: flag.project_id, metadata: { co_id: co.id },
          })
          return NextResponse.json({ ok: true, coId: co.id })
        }
        break
      }

      case 'confirm_out_of_scope': {
        // Borderline confirmed as out of scope — creates flag (spec §1.6.6, Event 18)
        if (!hasPermission(session, 'APPROVE_FLAGS'))
          return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS' }, { status: 403 })
        await (service as any).from('guardian_flags').update({
          status: 'open', updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name,
          eventType: 'flag.borderline_reviewed', entityType: 'guardian_flag', entityId: id,
          entityName: flag.project_id, metadata: { confirmed_as: 'out_of_scope' },
        })
        break
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
