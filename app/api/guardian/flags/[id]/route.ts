import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { sanitizePlainText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'

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
      .select('id,status,project_id,description,severity,sow_reference,change_order_id,projects(name)')
      .eq('id', id)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!flag) return NextResponse.json({ error: 'Flag not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, flag.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // FIX (audit round 6): every audit-log entry written by this route used
    // flag.project_id (a raw UUID) as entityName instead of the project's
    // actual name — every other Guardian route (check, inbound,
    // scope-adjustment) logs the readable name. Made the audit log/CSV
    // export show a UUID for every flag action instead of a project name.
    const projectName = flag.projects?.name || flag.project_id

    switch (action) {
      case 'resolve': {
        if (!hasPermission(session, 'APPROVE_FLAGS'))
          return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS' }, { status: 403 })
        // FIX (audit round 6): no action in this switch checked the flag's
        // current status before mutating it — resolve/close/exception could
        // all be fired on a flag that was already resolved, closed, or
        // converted to a change order, silently overwriting that state.
        if (flag.status !== 'open')
          return NextResponse.json({ error: `Cannot resolve a flag with status "${flag.status}"` }, { status: 409 })
        await (service as any).from('guardian_flags').update({
          status: 'resolved', resolution: 'closed',
          resolved_by: session.id, resolved_at: now, updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: 'flag.resolved', entityType: 'guardian_flag',
          entityId: id, entityName: projectName, metadata: {},
        })
        break
      }

      case 'close': {
        if (!hasPermission(session, 'APPROVE_FLAGS'))
          return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS' }, { status: 403 })
        if (!['open', 'resolved'].includes(flag.status))
          return NextResponse.json({ error: `Cannot close a flag with status "${flag.status}"` }, { status: 409 })
        await (service as any).from('guardian_flags').update({
          status: 'closed', resolution: 'closed', close_reason: reason || null,
          resolved_by: session.id, resolved_at: now, updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: 'flag.closed', entityType: 'guardian_flag', entityId: id,
          entityName: projectName, metadata: { reason },
        })
        break
      }

      case 'exception': {
        if (!hasPermission(session, 'GRANT_EXCEPTIONS'))
          return NextResponse.json({ error: 'Missing permission: GRANT_EXCEPTIONS' }, { status: 403 })
        if (flag.status !== 'open')
          return NextResponse.json({ error: `Cannot grant an exception on a flag with status "${flag.status}"` }, { status: 409 })
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
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: 'flag.exception_granted', entityType: 'guardian_flag', entityId: id,
          entityName: projectName, metadata: { estimated_value: estimatedValue },
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
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: 'flag.escalated', entityType: 'guardian_flag', entityId: id,
          entityName: projectName, metadata: { escalated_to: resolvedEscalateTo, note: safeNote },
        })
        break
      }

      case 'draft_co': {
        if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
          return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })
        // FIX (audit round 6): this action had no precondition check at
        // all — clicking it twice (or a slow-network double-submit, or two
        // concurrent requests) created two separate change_orders rows
        // both flag_id-linked to this flag (change_orders.flag_id has no
        // unique constraint), with guardian_flags.change_order_id only
        // ever pointing at whichever insert finished last, leaving the
        // other one orphaned but live. A plain "read flag.status, then
        // decide" check still has the same race — two concurrent requests
        // can both read status='open' before either writes. Use the same
        // compare-and-swap approach already used for this codebase's
        // signing routes: atomically claim the flag first (the update only
        // succeeds if it's still open AND unconverted), and only create
        // the change order if that claim succeeds.
        const { data: claimed } = await (service as any)
          .from('guardian_flags')
          .update({ status: 'converted_to_co', updated_at: now })
          .eq('id', id).eq('status', 'open').is('change_order_id', null)
          .select('id')

        if (!claimed || claimed.length === 0) {
          return NextResponse.json({
            error: flag.change_order_id
              ? 'A change order has already been drafted from this flag'
              : `Cannot draft a change order from a flag with status "${flag.status}"`,
            coId: flag.change_order_id || undefined,
          }, { status: 409 })
        }

        // Create CO draft pre-filled from flag (spec §6.2)
        const { data: co, error: coErr } = await (service as any).from('change_orders').insert({
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
            change_order_id: co.id, updated_at: now,
          }).eq('id', id)
          await logAudit(service, {
            workspaceId: session.workspaceId, actorId: session.id,
            actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
            eventType: 'flag.converted_to_co', entityType: 'guardian_flag', entityId: id,
            entityName: projectName, metadata: { co_id: co.id },
          })
          return NextResponse.json({ ok: true, coId: co.id })
        }

        // CO creation failed after the claim succeeded — release the claim
        // so the flag isn't stranded as 'converted_to_co' with no CO.
        await (service as any).from('guardian_flags').update({
          status: 'open', updated_at: now,
        }).eq('id', id)
        return NextResponse.json({ error: coErr?.message || 'Could not create change order' }, { status: 500 })
      }

      case 'confirm_out_of_scope': {
        // FIX (audit round 6): this action's own comment always claimed to
        // be the reviewer step for a borderline item ("Borderline
        // confirmed as out of scope"), but nothing ever created a flag in
        // a state this could act on — 'borderline_review' didn't exist as
        // a status until this fix round, so this action was unreachable.
        // Now that check/route.ts and inbound/route.ts actually create
        // borderline_review flags, gate the transition on that status.
        if (!hasPermission(session, 'APPROVE_FLAGS'))
          return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS' }, { status: 403 })
        if (flag.status !== 'borderline_review')
          return NextResponse.json({ error: `Cannot confirm a flag with status "${flag.status}" as out of scope` }, { status: 409 })
        await (service as any).from('guardian_flags').update({
          status: 'open', updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: 'flag.borderline_reviewed', entityType: 'guardian_flag', entityId: id,
          entityName: projectName, metadata: { confirmed_as: 'out_of_scope' },
        })
        break
      }

      case 'dismiss_borderline': {
        // FIX (audit round 6): borderline_review flags need a way to be
        // dismissed as a false positive, not just confirmed — otherwise
        // every borderline item a reviewer disagrees with just sits open
        // forever with no closing action available.
        if (!hasPermission(session, 'APPROVE_FLAGS'))
          return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS' }, { status: 403 })
        if (flag.status !== 'borderline_review')
          return NextResponse.json({ error: `Cannot dismiss a flag with status "${flag.status}"` }, { status: 409 })
        await (service as any).from('guardian_flags').update({
          status: 'closed', resolution: 'not_out_of_scope', close_reason: reason || null,
          resolved_by: session.id, resolved_at: now, updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: 'flag.borderline_reviewed', entityType: 'guardian_flag', entityId: id,
          entityName: projectName, metadata: { confirmed_as: 'in_scope', reason },
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
