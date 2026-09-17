import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { permissionsBeyondCeiling, permissionsBeyondActorForTarget, roleWithinCeiling } from '@/lib/utils/permission-ceiling'

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'INVITE_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission: INVITE_MEMBERS' }, { status: 403 })

    const service = createServiceClient()

    // FIX (deep audit, Team & Invites re-pass): invited_email wasn't
    // selected here, so revoking a pending invite always logged
    // 'member.invite_revoked' with a blank entityName — the one piece of
    // context (which email the invite was for) that actually matters for
    // this event, since there's often no `users` row to join for an
    // invite that was never accepted.
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id,user_id,status,invited_email,effective_permissions,users!workspace_members_user_id_fkey(name,email)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
    if (member.user_id === session.id)
      return NextResponse.json({ error: 'You cannot deactivate yourself' }, { status: 400 })

    // FIX (deep audit, section 6 — CRITICAL): this checked only
    // INVITE_MEMBERS + the self-deactivation guard above — nothing
    // compared the actor's permission level to the target's. Every other
    // consequential action in the Team surface (see the floor check
    // PATCH applies below via permissionsBeyondActorForTarget) enforces
    // "you can only act on permissions/people at or below your own
    // ceiling" — this was the one action that didn't, meaning a
    // narrowly-scoped custom role holding only INVITE_MEMBERS (e.g. an
    // onboarding-only role, which the ceiling model explicitly allows an
    // Owner to create) could deactivate the Owner or any admin outright.
    // Combined with there previously being no reactivation path at all,
    // that was a potentially irreversible lockout, not just a
    // permissions bug. The UI already hid the button for this case
    // (`!isOwner` in TeamClient.tsx) but that was client-side only.
    const beyond = permissionsBeyondActorForTarget(session, member.effective_permissions)
    if (beyond.length > 0) {
      return NextResponse.json({
        error: `Cannot deactivate a member who holds permissions you don't have yourself: ${beyond.join(', ')}`,
      }, { status: 403 })
    }

    const now = new Date().toISOString()

    // FIX (deep audit, Team & Invites re-pass — CRITICAL): revoking a
    // pending invite (status='invited', never accepted) used to run the
    // exact same soft `status: 'deactivated'` update as deactivating a
    // real member. That put a row with no attached user_id into the
    // "Deactivated" list next to actual former members — rendered as a
    // blank "Unknown" entry with no email — with the same "Reactivate"
    // button offered on it. Clicking Reactivate flipped it straight to
    // status: 'active' with user_id still null: a phantom "active member"
    // with no account, permanently visible in the roster, and (worse)
    // counted against the seat limit in team/invite/route.ts's
    // `.in('status', ['active','invited'])` check — silently eating a
    // paid seat that no real person occupies. The invite-cleanup cron's
    // 30-day purge only targets status IN ('invited','expired'), so once
    // soft-deactivated this row would never be swept either.
    //
    // A row that was never accepted was never really "a member" who could
    // later be brought back — there's nothing to reactivate. Revoking it
    // should remove it outright, the same way it's already gone the
    // moment `handleResendInvite` needs a clean slot to create a fresh
    // invite. Only a genuinely-active member (who really did once have
    // access) gets the soft, reactivable deactivation.
    //
    // FIX (deep audit, Team & Invites re-pass): 'expired' (cron/invite-
    // cleanup/route.ts's own status once a token's 7-day window closes)
    // is exactly the same "never became a member" case as 'invited' —
    // it's just a pending invite whose token died before anyone acted on
    // it. It needs the same hard-delete, not the soft-deactivate branch.
    const wasInvite = member.status === 'invited' || member.status === 'expired'

    if (wasInvite) {
      await (service as any).from('workspace_members').delete().eq('id', id)
    } else {
      // Deactivate membership
      await (service as any).from('workspace_members').update({
        status: 'deactivated', deactivated_at: now,
      }).eq('id', id)

      // Remove from all project_members
      await (service as any).from('project_members').delete().eq('member_id', id)

      // Invalidate sessions by deleting auth session — via Supabase Admin
      // (service role can't directly invalidate sessions; member will be blocked on next request via middleware)
    }

    // FIX (deep audit, section 5/6 tie-in): if the member being removed is
    // named as a specific-person approver on an active workflow, that step
    // can never be satisfied again once they're gone — nothing else in the
    // app surfaces this. Not a full reassignment flow, but at minimum
    // don't let it fail silently: note it in the audit trail and tell the
    // caller so the UI can warn them.
    const { data: affectedSteps } = await (service as any)
      .from('approval_workflow_steps')
      .select('id, workflow_id, approval_workflows!inner(name, is_active)')
      .eq('approver_user_id', member.user_id)
      .eq('approval_workflows.workspace_id', session.workspaceId)
      .eq('approval_workflows.is_active', true)
    const affectedWorkflowNames = Array.from(new Set((affectedSteps || []).map((s: any) => s.approval_workflows?.name).filter(Boolean)))

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: wasInvite ? 'member.invite_revoked' : 'member.deactivated',
      entityType: 'workspace_member',
      entityId: id, entityName: member.invited_email || member.users?.email || '',
      metadata: affectedWorkflowNames.length ? { orphaned_approval_workflows: affectedWorkflowNames } : {},
    })

    return NextResponse.json({
      ok: true,
      ...(affectedWorkflowNames.length ? {
        warning: `This person is named as an approver on: ${affectedWorkflowNames.join(', ')}. Update those workflows in Settings so documents don't get stuck waiting on them.`,
      } : {}),
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }   = await params
    const session  = await getSession()
    if (!session)  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body    = await request.json()
    const service = createServiceClient()

    // FIX (deep audit, section 6): deactivation was previously a one-way
    // door — no endpoint anywhere could flip a member back to 'active'.
    // Combined with the DELETE ceiling bug fixed above, a mistaken or
    // malicious deactivation had no in-app recovery path at all. This is
    // the same "act on team membership" capability as DELETE (not the
    // role-editing capability that gates the rest of this route), so it
    // gets its own permission + ceiling check, same as DELETE.
    if (typeof body.status === 'string') {
      if (!hasPermission(session, 'INVITE_MEMBERS'))
        return NextResponse.json({ error: 'Missing permission: INVITE_MEMBERS' }, { status: 403 })
      if (body.status !== 'active')
        return NextResponse.json({ error: 'Only reactivation (status: "active") is supported here — use DELETE to deactivate.' }, { status: 400 })

      const { data: member } = await (service as any)
        .from('workspace_members')
        .select('id,status,user_id,effective_permissions,users!workspace_members_user_id_fkey(email)')
        .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
      if (member.status !== 'deactivated')
        return NextResponse.json({ error: 'Member is not deactivated' }, { status: 400 })
      // FIX (deep audit, Team & Invites re-pass — CRITICAL, belt-and-
      // suspenders): a revoked, never-accepted invite is now hard-deleted
      // above rather than soft-deactivated (see DELETE), so this should
      // be unreachable in normal operation — but if a userless
      // 'deactivated' row ever exists regardless, reactivating it would
      // create a phantom "active member" with no account that still
      // counts against the seat limit. Refuse outright rather than
      // silently doing it.
      if (!member.user_id)
        return NextResponse.json({ error: 'This invite was never accepted and has no account to reactivate — send a new invite instead.' }, { status: 400 })

      const beyond = permissionsBeyondActorForTarget(session, member.effective_permissions)
      if (beyond.length > 0) {
        return NextResponse.json({
          error: `Cannot reactivate a member who holds permissions you don't have yourself: ${beyond.join(', ')}`,
        }, { status: 403 })
      }

      await (service as any).from('workspace_members').update({
        status: 'active', deactivated_at: null,
      }).eq('id', id)

      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'member.reactivated', entityType: 'workspace_member',
        entityId: id, entityName: member.users?.email || '',
        metadata: {},
      })

      return NextResponse.json({ ok: true })
    }

    if (!hasPermission(session, 'MANAGE_ROLES'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_ROLES' }, { status: 403 })

    const updates: Record<string, unknown> = {}

    // FIX (section-by-section re-audit, RLS+permissions Finding 2 —
    // CRITICAL): the ceiling checks below only ever block granting a NEW
    // true permission beyond the actor's own — a `false`-only
    // permissionOverrides payload always passes, since revoking isn't
    // escalation. That meant a bare MANAGE_ROLES holder could strip ANY
    // other member — including one with more permissions than the actor,
    // e.g. the actual workspace Owner — of everything, one member row at
    // a time. Floor check first, independent of direction: you cannot
    // touch a member who currently, effectively holds anything you don't
    // hold yourself.
    if (body.permissionOverrides !== undefined || body.roleId !== undefined) {
      const { data: targetMember } = await (service as any)
        .from('workspace_members').select('effective_permissions')
        .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!targetMember) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

      const outOfReach = permissionsBeyondActorForTarget(session, targetMember.effective_permissions)
      if (outOfReach.length > 0)
        return NextResponse.json({
          error: `Cannot modify a member who holds permissions you don't hold yourself: ${outOfReach.join(', ')}`,
        }, { status: 403 })
    }

    // FIX (audit round 4, finding #1 — CRITICAL): this let a MANAGE_ROLES
    // holder set permission_overrides on ANY member row — including their
    // own; unlike DELETE above there was no self-action guard — to
    // literally any permission set, which compute_effective_permissions()
    // (migration 001) merges straight into effective_permissions,
    // overrides winning per-key. Two fields, same rule as role
    // create/edit: you can only grant a permission you already hold.
    if (body.permissionOverrides !== undefined) {
      const beyond = permissionsBeyondCeiling(session, body.permissionOverrides)
      if (beyond.length > 0)
        return NextResponse.json({
          error: `Cannot grant permissions you don't hold yourself: ${beyond.join(', ')}`,
        }, { status: 403 })
      updates.permission_overrides = body.permissionOverrides
    }

    // FIX (audit round 4, finding #1, related): roleId was never verified
    // to (a) belong to this workspace, or (b) fit inside the actor's own
    // ceiling — compute_effective_permissions() looks the role up by id
    // with no workspace check either, so an unscoped roleId here could
    // pull in a completely different workspace's role permissions. Same
    // fix shape as app/api/team/invite/route.ts already applies.
    if (body.roleId !== undefined) {
      if (body.roleId) {
        const { data: role } = await (service as any)
          .from('roles').select('id,permissions').eq('id', body.roleId).eq('workspace_id', session.workspaceId).maybeSingle()
        if (!role) return NextResponse.json({ error: 'Invalid role for this workspace' }, { status: 400 })
        if (!roleWithinCeiling(session, role))
          return NextResponse.json({ error: 'Cannot assign a role with permissions you don\u2019t hold yourself' }, { status: 403 })
      }
      updates.role_id = body.roleId || null
    }

    const { error } = await (service as any)
      .from('workspace_members').update(updates).eq('id', id).eq('workspace_id', session.workspaceId)

    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: body.permissionOverrides ? 'member.permission_overridden' : 'member.role_changed',
      entityType: 'workspace_member', entityId: id, entityName: '',
      metadata: body,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
