import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendEscalationEmail } from '@/lib/email/templates'
import { sanitizePlainText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
import { filterByNotificationPreference } from '@/lib/utils/permissions-query'

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

    const { escalateTo, escalationNote } = await request.json()
    if (!escalationNote || escalationNote.trim().length < 10)
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
        .select('user_id, users!workspace_members_user_id_fkey!inner(id,name,email)')
        .eq('workspace_id', session.workspaceId)
        .eq('id', escalateTo)
        .eq('status', 'active')
        .single()
      if (member?.users) {
        resolvedEscalateTo = member.users.id
        assignee = { name: member.users.name, email: member.users.email }
      }
    }

    const now = new Date().toISOString()
    const safeNote = sanitizePlainText(escalationNote.trim())

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
    if (assignee?.email && resolvedEscalateTo) {
      const [allowed] = await filterByNotificationPreference(
        service, session.workspaceId, 'escalation',
        [{ id: resolvedEscalateTo }]
      )

      try {
        await (service as any).from('notifications').insert({
          workspace_id: session.workspaceId,
          recipient_id: resolvedEscalateTo,
          // FIX (deep audit round 3, notifications section): see the
          // matching comment in guardian/flags/[id]/route.ts — this and
          // that route's insert shared the bare 'escalation' type, making
          // it impossible for the bell to link to the right tab. The
          // 'escalation' preference key passed above is unchanged.
          type:         'escalation_co',
          title:        `Escalated — ${co.projects?.name || co.title}`,
          body:         `${session.name} escalated "${co.title}": ${safeNote}`,
          entity_type:  'project',
          entity_id:    co.project_id,
        })
      } catch { /* never let a notification failure break escalation */ }

      if (allowed) {
        try {
          await sendEscalationEmail({
            to:          assignee.email,
            assigneeName: assignee.name,
            agencyName:  session.agencyName,
            entityType:  'change order',
            entityName:  co.projects?.name || '',
            note:        safeNote,
            url:         `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
          })
        } catch (e) { console.error('Escalation email failed:', e) }
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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
