// app/api/team/[id]/route.ts

import { sendMemberAccessChangedEmail, sendMemberRoleChangedEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { notifyUsers } from '@/lib/utils/notify'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { permissionsBeyondCeiling, permissionsBeyondActorForTarget, roleWithinCeiling } from '@/lib/utils/permission-ceiling'
import { isProtectedOwnerTarget, OWNER_PROTECTED_MESSAGE } from '@/lib/utils/owner-protection'
import { parsePermissionMap } from '@/lib/utils/permission-map'
import { mergePermissions, protectedPermissionsOrphanedBy, describeProtectedPermission, PROTECTED_PERMISSIONS, approvalPermissionOrphanedBy, APPROVE_DOCUMENTS_ORPHAN_MESSAGE } from '@/lib/utils/admin-floor'
import { checkSeatLimit } from '@/lib/utils/seat-limit'
import { diffOverrides } from '@/lib/utils/permission-diff'

const namesOf = (rows: any[] | null | undefined, pick: (r: any) => string | undefined) =>
  Array.from(new Set((rows || []).map(pick).filter(Boolean))) as string[]

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'INVITE_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission: INVITE_MEMBERS' }, { status: 403 })

    const service = createServiceClient() as any

    const { data: member } = await service
      .from('workspace_members')
      .select('id,user_id,role_id,status,invited_email,effective_permissions,users!workspace_members_user_id_fkey(name,email)')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()

    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
    if (member.user_id === session.id)
      return NextResponse.json({ error: 'You cannot deactivate yourself' }, { status: 400 })
    if (member.status === 'deactivated')
      return NextResponse.json({ error: 'This member is already deactivated' }, { status: 409 })

    // An actor can only remove someone whose permissions are a subset of their own.
    const beyond = permissionsBeyondActorForTarget(session, member.effective_permissions)
    if (beyond.length > 0) {
      return NextResponse.json({
        error: `Cannot deactivate a member who holds permissions you don't have yourself: ${beyond.join(', ')}`,
      }, { status: 403 })
    }

    if (await isProtectedOwnerTarget(service, session.workspaceId, session.id, member.user_id))
      return NextResponse.json({ error: OWNER_PROTECTED_MESSAGE }, { status: 403 })

    const wasInvite = member.status === 'invited' || member.status === 'expired'

    // A pending invite holds no permissions of its own yet, so the check above passes trivially for
    // it — check the ROLE it would grant, the same standard Resend applies, so someone can't cancel
    // an invite into a role above their own.
    if (wasInvite && member.role_id) {
      const { data: inviteRole } = await service.from('roles').select('permissions').eq('id', member.role_id).maybeSingle()
      const beyondRole = permissionsBeyondActorForTarget(session, inviteRole?.permissions)
      if (beyondRole.length > 0) {
        return NextResponse.json({
          error: `Cannot revoke an invite for a role that holds permissions you don't have yourself: ${beyondRole.join(', ')}`,
        }, { status: 403 })
      }
    }

    // Projects where this person is the only assigned member: once they are
    // gone, nobody without VIEW_ALL_PROJECTS can see them. Collected before the
    // assignments are archived so the caller can be told.
    let soleProjectNames: string[] = []
    let revokedInviteCount = 0
    if (!wasInvite) {
      const { data: mine } = await service
        .from('project_members').select('project_id, projects(name)').eq('member_id', id)
      const projectIds = (mine || []).map((r: any) => r.project_id)
      if (projectIds.length > 0) {
        const { data: everyone } = await service
          .from('project_members').select('project_id, member_id').in('project_id', projectIds)
        const counts = new Map<string, number>()
        for (const row of everyone || []) counts.set(row.project_id, (counts.get(row.project_id) || 0) + 1)
        soleProjectNames = namesOf((mine || []).filter((r: any) => counts.get(r.project_id) === 1), r => r.projects?.name)
      }
    }

    if (wasInvite) {
      const { error } = await service.from('workspace_members').delete().eq('id', id)
      if (error) {
        console.error('Invite revoke failed:', error)
        return NextResponse.json({ error: 'Could not revoke the invite. Try again.' }, { status: 500 })
      }
    } else {
      // FIX (deep audit, RLS+permissions re-pass round 3 — HIGH): this used to
      // be two separate network round-trips — flip status to 'deactivated',
      // then a second, independent call to archive_member_projects() to set
      // aside their project assignments. If the second call ever failed (a
      // transient DB error, a timeout), the first had already committed and
      // was never rolled back — the old comment here said so outright
      // ("member is deactivated regardless"). Nothing retried it and nothing
      // ever swept for the orphaned project_members rows left behind. Because
      // canReadProject()/filterToProjectAccess() didn't independently check
      // workspace_members.status (see project-access.ts / permissions-query.ts
      // for that half of the fix), that failure mode was a PERMANENT, silent
      // authorization leak: a removed employee kept full read access to every
      // project they were on. Both steps are now one transaction (migration
      // 070's deactivate_member_atomic) — either both happen or neither does,
      // and a failure here is a real, surfaced error the admin can retry,
      // not a silent half-deactivation.
      const { data: deactivated, error } = await service.rpc('deactivate_member_atomic', {
        p_member_id: id, p_workspace_id: session.workspaceId,
      })
      if (error) {
        console.error('Member deactivate failed:', error)
        return NextResponse.json({ error: 'Could not deactivate this member. Try again.' }, { status: 500 })
      }
      if (!deactivated) {
        return NextResponse.json({ error: 'This member is already deactivated' }, { status: 409 })
      }

      // Invites this person SENT carry their authority to grant the invited role.
      // Once they're deactivated nobody vouches for those invites any more (they
      // used to stay valid for 7 days, and resend refreshed them) — revoke them.
      if (member.user_id) {
        const { data: revoked, error: revokeInvErr } = await service
          .from('workspace_members').delete()
          .eq('workspace_id', session.workspaceId).eq('invited_by', member.user_id)
          .in('status', ['invited', 'expired']).select('id')
        if (revokeInvErr) console.error('Could not revoke the deactivated member\u2019s pending invites (non-fatal):', revokeInvErr)
        revokedInviteCount = (revoked || []).length
      }
    }

    // Approval steps that name this person, directly or through a role only
    // they still hold, are left waiting on someone who can no longer act.
    let affectedWorkflowNames: string[] = []
    if (member.user_id) {
      const { data: direct } = await service
        .from('approval_workflow_steps')
        .select('id, approval_workflows!inner(name, is_active)')
        .eq('approver_user_id', member.user_id)
        .eq('approval_workflows.workspace_id', session.workspaceId)
        .eq('approval_workflows.is_active', true)
      affectedWorkflowNames = namesOf(direct, s => s.approval_workflows?.name)
    }
    if (!wasInvite && member.role_id && member.effective_permissions?.APPROVE_DOCUMENTS === true) {
      const { data: viaRole } = await service
        .from('approval_workflow_steps')
        .select('id, approval_workflows!inner(name, is_active)')
        .eq('approver_role_id', member.role_id)
        .eq('approval_workflows.workspace_id', session.workspaceId)
        .eq('approval_workflows.is_active', true)
      if ((viaRole || []).length > 0) {
        const { count: others } = await service
          .from('workspace_members').select('id', { count: 'exact', head: true })
          .eq('workspace_id', session.workspaceId).eq('role_id', member.role_id)
          .eq('status', 'active').neq('id', id)
        if ((others || 0) === 0) affectedWorkflowNames = Array.from(new Set([...affectedWorkflowNames, ...namesOf(viaRole, s => s.approval_workflows?.name)]))
      }
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: wasInvite ? 'member.invite_revoked' : 'member.deactivated',
      entityType: 'workspace_member',
      entityId: id, entityName: member.invited_email || member.users?.email || '',
      metadata: {
        ...(affectedWorkflowNames.length ? { orphaned_approval_workflows: affectedWorkflowNames } : {}),
        ...(soleProjectNames.length ? { sole_member_projects: soleProjectNames } : {}),
        ...(revokedInviteCount ? { revoked_pending_invites: revokedInviteCount } : {}),
      },
    })

    if (!wasInvite && member.user_id && member.users?.email) {
      await checkedSend(() => sendMemberAccessChangedEmail({
        to: member.users.email, name: member.users.name || '', agencyName: session.agencyName,
        change: 'deactivated', changedByName: session.name,
      }), 'Member deactivated email')
    }

    return NextResponse.json({
      ok: true,
      ...(affectedWorkflowNames.length ? {
        warning: `This person is named as an approver on: ${affectedWorkflowNames.join(', ')}. Update those workflows in Settings so documents don't get stuck waiting on them.`,
      } : {}),
      ...(revokedInviteCount ? {
        inviteWarning: `${revokedInviteCount} pending invite${revokedInviteCount === 1 ? '' : 's'} sent by ${member.users?.name || 'this person'} ${revokedInviteCount === 1 ? 'was' : 'were'} revoked with their access. Re-send ${revokedInviteCount === 1 ? 'it' : 'them'} from your own account if still needed.`,
      } : {}),
      ...(soleProjectNames.length ? {
        projectWarning: `${soleProjectNames.length === 1 ? 'This project was' : 'These projects were'} assigned only to ${member.users?.name || 'this person'}: ${soleProjectNames.slice(0, 5).join(', ')}${soleProjectNames.length > 5 ? ` and ${soleProjectNames.length - 5} more` : ''}. Until someone is assigned, only members who can view all projects will see ${soleProjectNames.length === 1 ? 'it' : 'them'}.`,
      } : {}),
    })
  } catch (err) {
    console.error('Team member DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }   = await params
    const session  = await getSession()
    if (!session)  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const service = createServiceClient() as any

    // ── Reactivation ──────────────────────────────────────────────────────────
    if (typeof body.status === 'string') {
      if (!hasPermission(session, 'INVITE_MEMBERS'))
        return NextResponse.json({ error: 'Missing permission: INVITE_MEMBERS' }, { status: 403 })
      if (body.status !== 'active')
        return NextResponse.json({ error: 'Only reactivation (status: "active") is supported here — use DELETE to deactivate.' }, { status: 400 })

      const { data: member } = await service
        .from('workspace_members')
        .select('id,status,user_id,role_id,effective_permissions,users!workspace_members_user_id_fkey(name,email,deleted_at)')
        .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
      if (member.status !== 'deactivated')
        return NextResponse.json({ error: 'Member is not deactivated' }, { status: 400 })
      if (!member.user_id)
        return NextResponse.json({ error: 'This invite was never accepted and has no account to reactivate — send a new invite instead.' }, { status: 400 })
      if (member.users?.deleted_at)
        return NextResponse.json({ error: 'This person deleted their account, so it can\u2019t be reactivated. Send a new invite if they should rejoin with a new account.' }, { status: 409 })

      const beyond = permissionsBeyondActorForTarget(session, member.effective_permissions)
      if (beyond.length > 0) {
        return NextResponse.json({
          error: `Cannot reactivate a member who holds permissions you don't have yourself: ${beyond.join(', ')}`,
        }, { status: 403 })
      }

      const seatCheck = await checkSeatLimit(service, session.workspaceId, session.planTier, ['active'])
      if (!seatCheck.ok) {
        return NextResponse.json({ error: seatCheck.message }, { status: 409 })
      }

      // FIX (independent re-audit, Team & Invites section): the `.eq('status',
      // 'deactivated')` guard here was already a compare-and-swap in shape,
      // but nothing checked whether it actually matched a row — an UPDATE
      // that matches zero rows is not an error in Postgres/Supabase, it just
      // returns no data. Two admins clicking Reactivate on the same member
      // within the same moment both pass the `member.status !== 'deactivated'`
      // check above (both read before either writes), then both run this
      // UPDATE: the first flips the row and matches; the second's WHERE no
      // longer matches anything (status is already 'active'), silently does
      // nothing, and — with no check here — the code went on regardless to
      // call restore_member_projects a second time, write a second
      // 'member.reactivated' audit row, and send a second "reactivated"
      // email, none of which should have happened for a member this request
      // never actually touched. Same shape as the DELETE handler's own
      // atomic RPC just above in this file, and the exact pattern
      // workspace/settings/route.ts's own compare-and-swap already checks
      // (`written.length === 0`) — this call site just never carried it over.
      const { data: reactivated, error: updateErr } = await service.from('workspace_members').update({
        status: 'active', deactivated_at: null,
      }).eq('id', id).eq('status', 'deactivated').select('id')
      if (updateErr) {
        console.error('Member reactivate failed:', updateErr)
        return NextResponse.json({ error: 'Could not reactivate this member. Try again.' }, { status: 500 })
      }
      if (!reactivated || reactivated.length === 0) {
        return NextResponse.json({ error: 'This member was already reactivated \u2014 possibly by someone else a moment ago.' }, { status: 409 })
      }

      const { data: restored, error: restoreErr } = await service.rpc('restore_member_projects', { p_member_id: id })
      if (restoreErr) console.error('restore_member_projects failed (member is active regardless):', restoreErr)
      const projectsRestored = typeof restored === 'number' ? restored : 0

      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'member.reactivated', entityType: 'workspace_member',
        entityId: id, entityName: member.users?.email || '',
        metadata: { projects_restored: projectsRestored },
      })

      if (member.users?.email) {
        await checkedSend(() => sendMemberAccessChangedEmail({
          to: member.users.email, name: member.users.name || '', agencyName: session.agencyName,
          change: 'reactivated', changedByName: session.name,
        }), 'Member reactivated email')
      }

      return NextResponse.json({
        ok: true, projectsRestored,
        ...(member.role_id ? {} : { warning: 'This member has no role, so they have no permissions yet. Assign a role from the Members tab.' }),
      })
    }

    // ── Role / permission-override changes ────────────────────────────────────
    if (!hasPermission(session, 'MANAGE_ROLES'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_ROLES' }, { status: 403 })

    if (body.roleId === undefined && body.permissionOverrides === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (body.roleId !== undefined && body.roleId !== null && typeof body.roleId !== 'string')
      return NextResponse.json({ error: 'Invalid role for this workspace' }, { status: 400 })
    let newOverrides: Record<string, boolean> | null | undefined = undefined
    if (body.permissionOverrides !== undefined) {
      if (body.permissionOverrides === null) newOverrides = null
      else {
        const parsed = parsePermissionMap(body.permissionOverrides)
        if (!parsed.ok) {
          return NextResponse.json({ error: parsed.error.replace('permissions payload', 'permission overrides payload') }, { status: 400 })
        }
        newOverrides = parsed.value
      }
    }

    const { data: targetMember } = await service
      .from('workspace_members').select('user_id,role_id,status,permission_overrides,effective_permissions,users!workspace_members_user_id_fkey(name,email)')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (!targetMember) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

    const outOfReach = permissionsBeyondActorForTarget(session, targetMember.effective_permissions)
    if (outOfReach.length > 0)
      return NextResponse.json({
        error: `Cannot modify a member who holds permissions you don't hold yourself: ${outOfReach.join(', ')}`,
      }, { status: 403 })

    if (await isProtectedOwnerTarget(service, session.workspaceId, session.id, targetMember.user_id))
      return NextResponse.json({ error: OWNER_PROTECTED_MESSAGE }, { status: 403 })

    if (newOverrides) {
      const beyond = permissionsBeyondCeiling(session, newOverrides)
      if (beyond.length > 0)
        return NextResponse.json({
          error: `Cannot grant permissions you don't hold yourself: ${beyond.join(', ')}`,
        }, { status: 403 })
    }

    let newRoleName: string | null = null
    let newRolePermissions: Record<string, unknown> | null | undefined = undefined // undefined = role not changing
    if (body.roleId !== undefined) {
      if (body.roleId) {
        const { data: role } = await service
          .from('roles').select('id,name,permissions').eq('id', body.roleId).eq('workspace_id', session.workspaceId).maybeSingle()
        if (!role) return NextResponse.json({ error: 'Invalid role for this workspace' }, { status: 400 })
        if (!roleWithinCeiling(session, role))
          return NextResponse.json({ error: 'Cannot assign a role with permissions you don\u2019t hold yourself' }, { status: 403 })
        newRolePermissions = role.permissions
        newRoleName = role.name || null
      } else {
        newRolePermissions = null
      }
    }

    // Work out what actually changes; a request that changes nothing does no
    // write, sends no notification and leaves no audit entry.
    const roleChanged = body.roleId !== undefined && (body.roleId || null) !== (targetMember.role_id || null)
    const overrideDiff = newOverrides !== undefined ? diffOverrides(targetMember.permission_overrides, newOverrides) : {}
    const overridesChanged = Object.keys(overrideDiff).length > 0
    if (!roleChanged && !overridesChanged) return NextResponse.json({ ok: true, unchanged: true })

    // A pending (or expired) invite is accepted against the authority of whoever `invited_by` names:
    // the accept route refuses it if that person can no longer grant the role. Changing the role of
    // an invite from a different admin's seat would otherwise leave it pointing at the original
    // inviter, who may not be able to grant the new role — the invitee would hit a dead end that
    // only a Resend fixes. So a role change on an invite is a re-issue: the person making it must be
    // able to invite, and becomes the inviter of record.
    const isPendingInvite = targetMember.status === 'invited' || targetMember.status === 'expired'
    const reattributeInvite = roleChanged && isPendingInvite
    if (reattributeInvite && !hasPermission(session, 'INVITE_MEMBERS'))
      return NextResponse.json({ error: 'Changing the role on a pending invite also needs the INVITE_MEMBERS permission, because you become the person who invited them.' }, { status: 403 })

    let oldRoleName: string | null = null
    let oldRolePermissions: Record<string, unknown> | null = null
    if (targetMember.role_id) {
      const { data: oldRole } = await service.from('roles').select('name,permissions').eq('id', targetMember.role_id).maybeSingle()
      oldRoleName = oldRole?.name ?? null
      oldRolePermissions = oldRole?.permissions ?? null
    }

    // Would this leave the workspace without anyone holding a protected permission?
    const finalOverrides = newOverrides !== undefined ? newOverrides : targetMember.permission_overrides
    const finalRolePermissions = newRolePermissions !== undefined ? newRolePermissions : oldRolePermissions
    const simulatedPerms = mergePermissions(finalRolePermissions, finalOverrides)

    // Application-layer floor for APPROVE_DOCUMENTS — see approvalPermissionOrphanedBy.
    if (targetMember.effective_permissions?.['APPROVE_DOCUMENTS'] === true && simulatedPerms!['APPROVE_DOCUMENTS'] !== true) {
      const { data: approvalMembers } = await service
        .from('workspace_members').select('id,effective_permissions')
        .eq('workspace_id', session.workspaceId).eq('status', 'active')
      const approvalSnapshot = (approvalMembers || []).map((m: any) => ({ id: m.id, effectivePermissions: m.effective_permissions }))
      if (approvalPermissionOrphanedBy(approvalSnapshot, new Map([[id, simulatedPerms]])))
        return NextResponse.json({ error: APPROVE_DOCUMENTS_ORPHAN_MESSAGE }, { status: 409 })
    }

    const losing = PROTECTED_PERMISSIONS.filter(
      perm => targetMember.effective_permissions?.[perm] === true && simulatedPerms![perm] !== true
    )
    if (losing.length > 0) {
      const { data: activeMembers } = await service
        .from('workspace_members').select('id,effective_permissions')
        .eq('workspace_id', session.workspaceId).eq('status', 'active')
      const snapshot = (activeMembers || []).map((m: any) => ({ id: m.id, effectivePermissions: m.effective_permissions }))
      const orphaned = protectedPermissionsOrphanedBy(snapshot, new Map([[id, simulatedPerms]]))
      if (orphaned.length > 0) {
        const label = orphaned.map(describeProtectedPermission).join(' or ')
        return NextResponse.json({
          error: `This would leave the workspace with no one who can ${label}. Assign ${orphaned.join(' / ')} to another member first — once nobody holds it, nobody can grant it back.`,
        }, { status: 409 })
      }
    }

    const { error } = await service.rpc('update_member_permissions_atomic', {
      p_workspace_id: session.workspaceId,
      p_member_id: id,
      p_set_role_id: body.roleId !== undefined,
      p_new_role_id: body.roleId || null,
      p_set_overrides: newOverrides !== undefined,
      p_new_overrides: newOverrides ?? null,
    })

    if (error) {
      if (error.message?.startsWith('would_orphan_permissions:')) {
        const orphaned = error.message.split(':')[1].split(',') as (typeof PROTECTED_PERMISSIONS)[number][]
        const label = orphaned.map(describeProtectedPermission).join(' or ')
        return NextResponse.json({
          error: `This would leave the workspace with no one who can ${label}. Assign ${orphaned.join(' / ')} to another member first — once nobody holds it, nobody can grant it back.`,
        }, { status: 409 })
      }
      throw new Error(error.message)
    }

    if (reattributeInvite) {
      const { error: reattrErr } = await service.from('workspace_members')
        .update({ invited_by: session.id }).eq('id', id).in('status', ['invited', 'expired'])
      if (reattrErr) console.error('Invite re-attribution failed (role changed regardless):', reattrErr)
    }

    let affectedWorkflowNames: string[] = []
    if (simulatedPerms && targetMember.effective_permissions?.['APPROVE_DOCUMENTS'] === true && simulatedPerms['APPROVE_DOCUMENTS'] !== true && targetMember.user_id) {
      const { data: affectedSteps } = await service
        .from('approval_workflow_steps')
        .select('id, approval_workflows!inner(name, is_active)')
        .eq('approver_user_id', targetMember.user_id)
        .eq('approval_workflows.workspace_id', session.workspaceId)
        .eq('approval_workflows.is_active', true)
      affectedWorkflowNames = namesOf(affectedSteps, s => s.approval_workflows?.name)
    }

    const target = {
      entityType: 'workspace_member', entityId: id,
      entityName: targetMember.users?.name || targetMember.users?.email || '',
    }
    const actor = {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
    }
    if (roleChanged) {
      await logAudit(service, {
        ...actor, ...target, eventType: 'member.role_changed',
        metadata: {
          role: { from: oldRoleName, to: newRoleName },
          ...(reattributeInvite ? { pending_invite: true, inviter_now: session.email } : {}),
          ...(affectedWorkflowNames.length ? { orphaned_approval_workflows: affectedWorkflowNames } : {}),
        },
      })
    }
    if (overridesChanged) {
      await logAudit(service, {
        ...actor, ...target, eventType: 'member.permission_overridden',
        metadata: {
          overrides: overrideDiff,
          ...(!roleChanged && affectedWorkflowNames.length ? { orphaned_approval_workflows: affectedWorkflowNames } : {}),
        },
      })
    }

    if (targetMember.user_id && targetMember.user_id !== session.id && targetMember.status === 'active') {
      const bodyText = roleChanged && newRoleName
        ? `${session.name} changed your role to ${newRoleName}.`
        : `${session.name} adjusted your permissions.`
      await notifyUsers(service, {
        workspaceId: session.workspaceId, recipientIds: [targetMember.user_id],
        type: 'member_role_changed', title: 'Your access changed', body: bodyText, entityType: 'team',
      })
      const email = targetMember.users?.email
      if (email) {
        await checkedSend(() => sendMemberRoleChangedEmail({
          to: email, name: targetMember.users?.name || '', agencyName: session.agencyName,
          roleName: roleChanged ? newRoleName : null, changedByName: session.name,
        }), 'Member role changed email')
      }
    }

    return NextResponse.json({
      ok: true,
      ...(affectedWorkflowNames.length ? {
        warning: `This person is named as an approver on: ${affectedWorkflowNames.join(', ')}. They may no longer be able to act on those steps — update those workflows in Settings so documents don't get stuck waiting on them.`,
      } : {}),
    })
  } catch (err) {
    console.error('Team member PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
