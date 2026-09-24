import { notifyUsers } from '@/lib/utils/notify'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { sanitizePlainText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
import { sendEscalationEmail } from '@/lib/email/templates'
import { filterByNotificationPreference, filterToProjectAccess } from '@/lib/utils/permissions-query'
import { checkedSend } from '@/lib/email/delivery'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body    = await request.json()
    const { action, projectId, reason, escalateTo, escalationNote } = body
    const service = createServiceClient()
    const now     = new Date().toISOString()

    // FIX (re-audit): added check_id + the linked guardian_checks.creep_
    // confidence so 'confirm_out_of_scope' below can give the flag a real
    // severity instead of leaving it at the placeholder 'info' forever —
    // see that case for the full note.
    const { data: flag } = await (service as any)
      .from('guardian_flags')
      .select('id,status,project_id,description,severity,sow_reference,change_order_id,check_id,escalated_to,escalation_note,projects(name),guardian_checks(creep_confidence)')
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
        // FIX (deep audit, section 13, finding #1): estimatedValue/
        // exceptionReason were accepted here but nothing on the frontend
        // ever sent them (FlagCard's generic handleAction posted only
        // {action, projectId}) — every exception silently recorded $0 and
        // an empty reason, corrupting the Reports "exceptions granted"
        // total and cron/scope-health-rollup's contract-value-at-risk
        // math. Now that ExceptionModal collects both, require the reason
        // — the whole point of this record is documenting why scope was
        // given away for free — and reject a non-numeric value instead of
        // silently coercing it to 0.
        if (!exceptionReason || !exceptionReason.trim())
          return NextResponse.json({ error: 'A reason is required to grant an exception' }, { status: 400 })
        const parsedValue = estimatedValue === undefined || estimatedValue === '' ? 0 : parseFloat(estimatedValue)
        if (Number.isNaN(parsedValue) || parsedValue < 0)
          return NextResponse.json({ error: 'Estimated value must be a non-negative number' }, { status: 400 })
        await (service as any).from('exceptions_log').insert({
          project_id:   flag.project_id,
          workspace_id: session.workspaceId,
          flag_id:      id,
          deliverable:  flag.sow_reference,
          granted_what: sanitizePlainText(grantedWhat || flag.description),
          granted_by:   session.id,
          estimated_value: parsedValue,
          reason:       sanitizePlainText(exceptionReason.trim()),
        })
        await (service as any).from('guardian_flags').update({
          status: 'resolved', resolution: 'exception',
          resolved_by: session.id, resolved_at: now, updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: 'flag.exception_granted', entityType: 'guardian_flag', entityId: id,
          entityName: projectName, metadata: { estimated_value: parsedValue },
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

        // FIX (deep audit, section 13, finding #7): this action had no
        // status guard at all — a resolved/closed/converted_to_co flag
        // could still be "escalated", pinging someone about a matter
        // that's already finished. Mirrors co/[id]/escalate's 10-G5 fix
        // (escalation is an overlay on something still open).
        if (!['open', 'borderline_review'].includes(flag.status)) {
          return NextResponse.json(
            { error: `This flag is ${flag.status.replace(/_/g, ' ')} — there's nothing open to escalate.` },
            { status: 400 }
          )
        }

        // FIX (audit round 2, item #5): escalateTo was never checked
        // against workspace membership — resolve it scoped to this
        // workspace, falling back to self-assignment if it doesn't
        // resolve to an active member here, same treatment as
        // co/[id]/escalate.
        //
        // FIX (deep audit, section 13 — flagship finding): this filtered
        // workspace_members by `.eq('user_id', escalateTo)`, but
        // EscalateFlagModal's dropdown sends `t.workspace_members.id` — the
        // row's own primary key, not the user's id (the `team` prop here is
        // sourced from project_members, whose `member_id` column itself
        // references workspace_members(id), which is why the option value
        // was built that way). Those two ids never coincide, so this query
        // matched nothing for every real selection, silently fell through
        // to the `resolvedEscalateTo || session.id` self-assignment below,
        // and reported success — every "escalate to <teammate>" action
        // actually escalated to the person clicking the button, with no
        // error, no email, and no notification ever reaching who was
        // actually picked. Match on the row's own id instead, which is
        // what the dropdown actually sends and what this table's own
        // primary key is.
        let resolvedEscalateTo: string | null = null
        let assignee: { name: string; email: string } | null = null
        if (escalateTo) {
          const { data: member } = await (service as any)
            .from('workspace_members')
            .select('user_id, effective_permissions, users!workspace_members_user_id_fkey!inner(id,name,email)')
            .eq('workspace_id', session.workspaceId)
            .eq('id', escalateTo)
            .eq('status', 'active')
            .single()
          // FIX (Notifications & email fix round): an unknown / inactive assignee used to
          // fall through silently — the flag was escalated to the caller instead and nobody
          // was told. Reject it so the user knows the escalation didn't go where they chose.
          if (!member?.users)
            return NextResponse.json({ error: 'That person is not an active member of this workspace.' }, { status: 400 })
          // FIX: the assignee's project access was never checked, so the notification and email
          // (project name + the escalation note) went to someone who then hit a 403 on the link.
          if (member.users.id !== session.id) {
            const canOpen = await filterToProjectAccess(
              service, flag.project_id, [{ id: member.users.id }],
              new Map([[member.users.id, member.effective_permissions || {}]])
            )
            if (canOpen.length === 0)
              return NextResponse.json({
                error: `${member.users.name} doesn't have access to this project. Add them to the project first, or choose someone else.`,
              }, { status: 400 })
          }
          resolvedEscalateTo = member.users.id
          assignee = { name: member.users.name, email: member.users.email }
        }
        const safeNote = sanitizePlainText(escalationNote)

        // FIX (deep audit, section 13, finding #7): escalated_to/
        // escalation_note are a single overwritable slot, same as CO's —
        // record what it held before this overwrite in the audit metadata
        // so the chain is reconstructable.
        const previousEscalation = { to: flag.escalated_to ?? null, note: flag.escalation_note ?? null }

        // Spec §6.3: escalation NEVER changes status — it is an overlay
        await (service as any).from('guardian_flags').update({
          escalated_to:    resolvedEscalateTo || session.id,
          escalation_note: safeNote,
          updated_at:      now,
        }).eq('id', id)

        // FIX (deep audit, section 13, finding #7): unlike co/[id]/escalate,
        // this action never sent an email or created an in-app notification
        // for the assignee — the 'escalation' preference toggle in Settings
        // existed and applied to CO escalations only. Same treatment here.
        // Escalating to yourself (or with no assignee) just records ownership — nothing to announce.
        if (assignee?.email && resolvedEscalateTo && resolvedEscalateTo !== session.id) {
          await notifyUsers(service, {
            workspaceId: session.workspaceId, recipientIds: [resolvedEscalateTo],
            type: 'escalation_flag', eventType: 'escalation',
            title: `Escalated — ${projectName}`,
            body: `${session.name} escalated a scope flag: ${safeNote}`,
            entityType: 'project', entityId: flag.project_id, projectId: flag.project_id,
          })

          const [emailAllowed] = await filterByNotificationPreference(
            service, session.workspaceId, 'escalation',
            [{ id: resolvedEscalateTo }], 'email'
          )
          if (emailAllowed) {
            // sendEscalationEmail returns { ok:false } on a provider rejection instead of throwing, so the
            // old try/catch logged nothing for exactly the failures it existed to catch.
            await checkedSend(() => sendEscalationEmail({
              to:           assignee.email,
              assigneeName: assignee.name,
              agencyName:   session.agencyName,
              entityType:   'scope flag',
              entityName:   projectName,
              note:         safeNote,
              url:          `${process.env.NEXT_PUBLIC_APP_URL}/projects/${flag.project_id}?tab=guardian`,
            }), 'flag escalation email')
          }
        }

        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: 'flag.escalated', entityType: 'guardian_flag', entityId: id,
          entityName: projectName, metadata: {
            escalated_to: resolvedEscalateTo, note: safeNote,
            ...(previousEscalation.to || previousEscalation.note ? { superseded: previousEscalation } : {}),
          },
        })
        break
      }

      case 'draft_co': {
        if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
          return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

        // FIX (section-10 audit, cross-cutting): app/api/co/route.ts hard-
        // blocks CO creation on a project with no signed SOW ("a change
        // order can only be created once the original scope of work is
        // signed" — the section-10 headline fix, since finalize-co.ts
        // hard-blocks the client's acceptance on this same condition, and
        // discovering that AFTER a client has already reviewed, typed
        // their name and drawn a signature is strictly worse for
        // everyone). This second, independent change_orders write path —
        // drafting a CO straight from a Guardian flag — never got that
        // same check, so it was still fully reachable on a project with
        // no signed SOW. Same guard, same place in the flow: before the
        // flag claim below, so a blocked draft doesn't even consume the
        // flag's one-shot conversion.
        const { data: signedSow } = await (service as any)
          .from('sow_documents').select('id')
          .eq('project_id', flag.project_id).eq('status', 'signed')
          .limit(1).maybeSingle()
        if (!signedSow) {
          return NextResponse.json({
            error: 'This project has no signed SOW yet — a change order can only be created once the original scope of work is signed.',
          }, { status: 409 })
        }

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
          // FIX (section-10 audit, cross-cutting): line_items is a jsonb
          // column — JSON.stringify(...) here stores a JSON-encoded
          // STRING inside it, not a native array. app/api/co/route.ts's
          // own comment already flagged this exact anti-pattern as fixed
          // system-wide ("always the bug, not an intentional
          // convention"), but this second, independent write path into
          // the same column was missed. Every reader already defensively
          // handles the string case, so this never crashed — but it's the
          // same debt the other fix claimed to have eliminated. Write the
          // native array directly, matching every other CO-creating path.
          line_items:   [{
            id:          crypto.randomUUID(),
            description: flag.description,
            quantity:    1,
            rate:        0,
            total:       0,
          }],
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
        // FIX (re-audit): this left severity at 'info' forever — the
        // placeholder value borderline flags are created with specifically
        // so they don't falsely claim a high/medium/low confidence (see
        // guardian/check's comment). Once a human confirms it IS real scope
        // creep, it's no longer borderline — give it a real severity using
        // the exact same creepConfidence thresholds guardian/check uses for
        // a same out_of_scope flag, so it stops being silently undercounted
        // as 'low' everywhere severity is aggregated (e.g.
        // cron/scope-health-rollup's contract-value-at-risk math, which has
        // no 'info' bucket at all).
        const creepConfidence = flag.guardian_checks?.creep_confidence
        const severity = typeof creepConfidence === 'number'
          ? (creepConfidence >= 0.90 ? 'high' : creepConfidence >= 0.75 ? 'medium' : 'low')
          : 'medium' // no linked check (shouldn't happen via the normal flow) — safe non-extreme default
        await (service as any).from('guardian_flags').update({
          status: 'open', severity, updated_at: now,
        }).eq('id', id)
        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: 'flag.borderline_reviewed', entityType: 'guardian_flag', entityId: id,
          entityName: projectName, metadata: { confirmed_as: 'out_of_scope', severity },
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
    console.error('guardian/flags/[id] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
