import { notifyUsers } from '@/lib/utils/notify'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendEscalationEmail } from '@/lib/email/templates'
import { canReadProject } from '@/lib/utils/project-access'
import { filterByNotificationPreference, filterToProjectAccess } from '@/lib/utils/permissions-query'
import { cleanTextField } from '@/lib/utils/sanitize'
import { checkedSend } from '@/lib/email/delivery'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // FIX (audit round 2, item #5): this action had no permission check at
    // all, unlike SEND_CHANGE_ORDERS gating every other client/stakeholder
    // -facing action on a CO (send, remind, accept-counter).
    if (!hasPermission(session, 'SEND_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: SEND_CHANGE_ORDERS' }, { status: 403 })

    const reqBody = await request.json().catch(() => ({} as any))
    const escalateTo = reqBody?.escalateTo
    if (escalateTo !== undefined && escalateTo !== null && typeof escalateTo !== 'string')
      return NextResponse.json({ error: 'escalateTo must be a team member id' }, { status: 400 })
    // Plain text, decoded (sanitizePlainText no longer HTML-escapes, so "R&D" is stored — and later
    // emailed — as "R&D", not "R&amp;D" / "R&amp;amp;D").
    const safeNote = cleanTextField(reqBody?.escalationNote, 2000)
    if (safeNote === null || safeNote.length < 10)
      return NextResponse.json({ error: 'Escalation note must be at least 10 characters' }, { status: 400 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select('id,title,status,project_id,escalated_to,escalation_note,projects(name)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })
    // FIX (audit round 3): see lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // FIX (section-10 audit, 10-G5): escalation had no status guard at
    // all, so an accepted, closed or withdrawn CO could still be
    // escalated — pinging a colleague to go chase something that is
    // already finished. Escalation is an overlay on an OPEN negotiation
    // (spec §6.3: it never changes status), so it only makes sense while
    // one is open. Mirrors the states CoCard already shows the escalate
    // control for.
    // FIX (section-10 audit, feature gap — CO expiry): 'expired' added —
    // a dead signing link is exactly as terminal as accepted/closed/
    // withdrawn for this purpose; nothing left to escalate.
    if (['accepted', 'closed', 'withdrawn', 'exception_granted', 'expired'].includes(co.status))
      return NextResponse.json(
        { error: `This change order is ${co.status.replace(/_/g, ' ')} — there's nothing open to escalate.` },
        { status: 400 }
      )

    // FIX (audit round 2, item #5): escalateTo was never checked against
    // workspace membership — any authenticated session could escalate to
    // an arbitrary user id anywhere on the platform, both writing a
    // cross-tenant reference into escalated_to and emailing that stranger
    // this workspace's project name, agency name, and an attacker-chosen
    // note. Resolve the assignee scoped to this workspace; if the id
    // doesn't resolve to a member here, treat it as absent (falls back to
    // self-assignment) rather than erroring the whole request.
    //
    // FIX (deep audit, section 13 — flagship finding, traced to CO
    // escalate): this filtered workspace_members by `.eq('user_id',
    // escalateTo)`, but EscalateCoModal's dropdown sends
    // `t.workspace_members.id` — the row's own primary key, not the
    // user's id (this file's `team` prop is sourced the same way as
    // Guardian's, via project_members, whose `member_id` column itself
    // references workspace_members(id)). Those two ids never coincide, so
    // this query matched nothing for every real selection and silently
    // fell through to the `resolvedEscalateTo || session.id`
    // self-assignment below — every "escalate to <teammate>" actually
    // escalated to the person clicking the button, with a fake success and
    // no email or notification ever reaching who was actually picked.
    // Match on the row's own id instead, matching what the dropdown sends.
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
      if (member?.users) {
        // FIX (Notifications & email fix round): the assignee's access to the project was never
        // checked — the notification and email (project name + note) went to someone who then
        // hit a 403 on the link.
        if (member.users.id !== session.id) {
          const canOpen = await filterToProjectAccess(
            service, co.project_id, [{ id: member.users.id }],
            new Map([[member.users.id, member.effective_permissions || {}]])
          )
          if (canOpen.length === 0)
            return NextResponse.json({
              error: `${member.users.name} doesn't have access to this project. Add them to the project first, or choose someone else.`,
            }, { status: 400 })
        }
        resolvedEscalateTo = member.users.id
        assignee = { name: member.users.name, email: member.users.email }
      } else {
        // Silently assigning the escalation to the person who clicked (and reporting success) meant a
        // removed or deactivated team member turned "escalate to Jane" into a note-to-self that
        // nobody else ever saw.
        return NextResponse.json({ error: 'That team member is no longer available. Pick someone else.' }, { status: 400 })
      }
    }

    const now = new Date().toISOString()

    // FIX (section-10 audit, 10-G5): escalated_to/escalation_note are a
    // single overwritable slot — a second escalation silently replaced
    // the first with no history and no way to see that it had happened.
    // The audit log is the history (it always recorded every escalation;
    // nothing ever read it back), so record the previous holder on the
    // new audit row to make the chain reconstructable.
    const previousEscalation = { to: (co as any).escalated_to ?? null, note: (co as any).escalation_note ?? null }

    // Spec §6.3: escalation NEVER changes status — it is an overlay
    await (service as any).from('change_orders').update({
      escalated_to:    resolvedEscalateTo || session.id,
      escalation_note: safeNote,
      updated_at:      now,
    }).eq('id', id)

    // Event 24: escalation notification
    // FIX (audit): 'escalation' has a real toggle in Settings → Notifications
    // and is in the preferences EVENT_TYPES whitelist, but this route never
    // checked it — the email always sent regardless of the assignee's
    // preference, and no in-app notification was ever created (so it also
    // never showed up in the bell). Gate the email by preference, same as
    // every other notification type, and add the missing in-app row.
    // Escalating to yourself just records ownership — nothing to announce.
    if (assignee?.email && resolvedEscalateTo && resolvedEscalateTo !== session.id) {
      const [emailAllowed] = await filterByNotificationPreference(
        service, session.workspaceId, 'escalation',
        [{ id: resolvedEscalateTo }], 'email'
      )
      await notifyUsers(service, {
        workspaceId: session.workspaceId, recipientIds: [resolvedEscalateTo],
        type: 'escalation_co', eventType: 'escalation',
        title: `Escalated — ${co.projects?.name || co.title}`,
        body: `${session.name} escalated "${co.title}": ${safeNote}`,
        entityType: 'project', entityId: co.project_id, projectId: co.project_id,
      })

      if (emailAllowed) {
        await checkedSend(() => sendEscalationEmail({
          to:          assignee!.email,
          assigneeName: assignee!.name,
          agencyName:  session.agencyName,
          entityType:  'change order',
          entityName:  co.projects?.name || '',
          note:        safeNote,
          url:         `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
        }), 'CO escalation email')
      }
    }

    // co.escalated is an AUDIT EVENT TYPE — records the action
    // It is NOT a status value (BUG-049)
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.escalated', entityType: 'change_order',
      entityId: id, entityName: co.title,
      metadata: {
        escalated_to: resolvedEscalateTo, note: safeNote, co_status: co.status,
        ...(previousEscalation.to || previousEscalation.note ? { superseded: previousEscalation } : {}),
      },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('CO escalate error:', err)
    return NextResponse.json({ error: 'Could not escalate this change order. Please try again.' }, { status: 500 })
  }
}
