import { sendMemberAccessChangedEmail, sendMemberRoleChangedEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { notifyUsers } from '@/lib/utils/notify'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { permissionsBeyondCeiling, permissionsBeyondActorForTarget, roleWithinCeiling } from '@/lib/utils/permission-ceiling'
import { parsePermissionMap } from '@/lib/utils/permission-map'
import { mergePermissions, protectedPermissionsOrphanedBy, describeProtectedPermission, PROTECTED_PERMISSIONS } from '@/lib/utils/admin-floor'
import { checkSeatLimit } from '@/lib/utils/seat-limit'

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

    // FEATURE (Notifications & email fix round): being deactivated only ever surfaced as a login
    // that stopped working. Sent regardless of notification preferences — it concerns their own access.
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
    })
  } catch (err) {
    // FIX (deep audit, Team & Invites re-pass): raw exception messages
    // were returned straight to the client here — the same
    // info-disclosure pattern already fixed for workspace/settings,
    // /defaults, /branding and invite/[token]/accept, missed across this
    // entire Team API surface. Log server-side only.
    console.error('Team member DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
        .select('id,status,user_id,effective_permissions,users!workspace_members_user_id_fkey(name,email)')
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

      // FIX (deep audit, section 6 — flagship finding): reactivation was
      // the third of three places a member could become 'active' with
      // zero seat-limit enforcement (see lib/utils/seat-limit.ts for the
      // other two and the full writeup) — and the most self-contained one,
      // needing no external plan change or timing window at all: on a
      // 2-seat plan, deactivate a member, invite+accept a replacement
      // (2/2 active again), then reactivate the first one straight past
      // the limit with nothing objecting anywhere.
      const seatCheck = await checkSeatLimit(service, session.workspaceId, session.planTier, ['active'])
      if (!seatCheck.ok) {
        return NextResponse.json({ error: seatCheck.message }, { status: 409 })
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

      if (member.users?.email) {
        await checkedSend(() => sendMemberAccessChangedEmail({
          to: member.users.email, name: member.users.name || '', agencyName: session.agencyName,
          change: 'reactivated', changedByName: session.name,
        }), 'Member reactivated email')
      }

      return NextResponse.json({ ok: true })
    }

    if (!hasPermission(session, 'MANAGE_ROLES'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_ROLES' }, { status: 403 })

    // A body carrying neither roleId nor permissionOverrides had nothing
    // for the RPC below to actually change — reject it here with a 400
    // instead of making a pointless round trip that sets both to "leave
    // unchanged" and returns ok:true for a no-op.
    if (body.roleId === undefined && body.permissionOverrides === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    // FIX (build — RLS + permissions independent audit, HIGH): overrides must be a
    // strict { PERMISSION: boolean } map (null clears them). Anything else — 1,
    // "yes", nested objects — used to be stored as-is and granted by getSession()'s
    // truthiness filter while the ceiling ignored it. See lib/utils/permission-map.ts.
    if (body.permissionOverrides !== undefined && body.permissionOverrides !== null) {
      const parsed = parsePermissionMap(body.permissionOverrides)
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error.replace('permissions payload', 'permission overrides payload') }, { status: 400 })
      }
      body.permissionOverrides = parsed.value
    }

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
    // FIX (deep audit, RLS+permissions independent re-pass — CRITICAL):
    // fetch role_id/permission_overrides too, not just effective_permissions
    // — the admin-floor simulation below needs them to compute what this
    // member's effective_permissions would become post-change.
    // FIX (deep audit, Settings re-pass — audit-trail traceability): this
    // select never fetched the member's email, so the logAudit call below
    // always logged entityName: '' for 'member.role_changed' /
    // 'member.permission_overridden' — unlike DELETE's own audit call
    // just above, which was already fixed to include invited_email/email
    // for exactly this reason. Every row this route writes showed up in
    // Settings → Audit Log with no way to tell which member it was about
    // short of looking up the raw entityId UUID by hand, and it couldn't
    // be found via the log's own free-text search either (that matches
    // on entity_name). Pull the email alongside the fields already
    // fetched for the ceiling/floor checks.
    let targetMember: { user_id: string | null; role_id: string | null; permission_overrides: Record<string, unknown> | null; effective_permissions: Record<string, unknown> | null; users?: { name: string | null; email: string | null } | null } | null = null
    if (body.permissionOverrides !== undefined || body.roleId !== undefined) {
      const { data } = await (service as any)
        .from('workspace_members').select('user_id,role_id,permission_overrides,effective_permissions,users!workspace_members_user_id_fkey(name,email)')
        .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!data) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
      targetMember = data

      const outOfReach = permissionsBeyondActorForTarget(session, targetMember!.effective_permissions)
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
    }

    // FIX (audit round 4, finding #1, related): roleId was never verified
    // to (a) belong to this workspace, or (b) fit inside the actor's own
    // ceiling — compute_effective_permissions() looks the role up by id
    // with no workspace check either, so an unscoped roleId here could
    // pull in a completely different workspace's role permissions. Same
    // fix shape as app/api/team/invite/route.ts already applies.
    let newRoleName: string | null = null
    let newRolePermissions: Record<string, unknown> | null | undefined = undefined // undefined = role_id not changing
    if (body.roleId !== undefined) {
      if (body.roleId) {
        const { data: role } = await (service as any)
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

    // FIX (deep audit, RLS+permissions independent re-pass — CRITICAL):
    // leave_workspace_atomic() (027/034/038) refuses to let the sole
    // MANAGE_ROLES holder leave, specifically to prevent "a one-way
    // lockout of the permission system itself, with no self-service
    // recovery" (034's own words) — but that guard only fires on leave.
    // This route reaches the exact same end state (a member losing
    // MANAGE_ROLES via permission_overrides or a role reassignment) with
    // no equivalent check — and since the ceiling/floor checks above only
    // ever compare the actor to the target, they pass trivially when an
    // admin edits their OWN permissions, letting the sole holder strip
    // themselves with nothing to stop it. Simulate the target's
    // post-change effective_permissions and refuse if it would leave the
    // workspace with zero active MANAGE_ROLES holders.
    // FIX (section-11/12 audit): hoisted out of the MANAGE_ROLES-only branch
    // below so the same simulated post-change permission set can also back
    // the APPROVE_DOCUMENTS warning further down — previously this was only
    // ever computed when the member currently held MANAGE_ROLES.
    let simulatedPerms: Record<string, unknown> | null = null
    if (targetMember) {
      const finalOverrides = body.permissionOverrides !== undefined ? body.permissionOverrides : targetMember.permission_overrides
      const finalRolePermissions = newRolePermissions !== undefined
        ? newRolePermissions
        : (targetMember.role_id
            ? (await (service as any).from('roles').select('permissions').eq('id', targetMember.role_id).maybeSingle()).data?.permissions
            : null)
      simulatedPerms = mergePermissions(finalRolePermissions, finalOverrides)

      // FIX (deep audit, Team & Invites section — HIGH): same one-key
      // blind spot as the sibling check in api/team/roles/[id] — this
      // guarded MANAGE_ROLES only, while leave_workspace_atomic
      // (027/034/038) guards MANAGE_WORKSPACE_SETTINGS too. A member
      // override (or a role reassignment) that removed the workspace's
      // last MANAGE_WORKSPACE_SETTINGS holder passed unchallenged, and
      // the ceiling rule then makes it impossible to grant back. See
      // lib/utils/admin-floor.ts.
      const losing = PROTECTED_PERMISSIONS.filter(
        perm => targetMember.effective_permissions?.[perm] === true && simulatedPerms![perm] !== true
      )
      if (losing.length > 0) {
        const { data: activeMembers } = await (service as any)
          .from('workspace_members').select('id,effective_permissions')
          .eq('workspace_id', session.workspaceId).eq('status', 'active')
        const snapshot = (activeMembers || []).map((m: any) => ({ id: m.id, effectivePermissions: m.effective_permissions }))
        const simulated = new Map([[id, simulatedPerms]])
        const orphaned = protectedPermissionsOrphanedBy(snapshot, simulated)
        if (orphaned.length > 0) {
          const label = orphaned.map(describeProtectedPermission).join(' or ')
          return NextResponse.json({
            error: `This would leave the workspace with no one who can ${label}. Assign ${orphaned.join(' / ')} to another member first — once nobody holds it, nobody can grant it back.`,
          }, { status: 409 })
        }
      }
    }

    // FIX (deep audit, RLS+permissions independent re-pass — CRITICAL):
    // the pre-check just above is a plain SELECT with no lock and no
    // transaction tying it to this write — two concurrent requests
    // touching different members (or the same member twice, e.g. a
    // doubled-up submit) can each read the same pre-change snapshot,
    // each see someone else still holds the permission, and both
    // proceed, jointly orphaning it. Kept above as a fast, friendly
    // pre-check; migration 055's update_member_permissions_atomic is the
    // actual gate — it locks the workspace's active membership first, so
    // a second concurrent call re-evaluates against real post-commit
    // state instead of this same stale read. See that migration's
    // comment for an empirically-raced reproduction of exactly this
    // failure mode (against the sibling role-edit path) and its fix.
    const { error } = await (service as any).rpc('update_member_permissions_atomic', {
      p_workspace_id: session.workspaceId,
      p_member_id: id,
      p_set_role_id: body.roleId !== undefined,
      p_new_role_id: body.roleId || null,
      p_set_overrides: body.permissionOverrides !== undefined,
      p_new_overrides: body.permissionOverrides ?? null,
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

    // FIX (section-11 audit): editing a member's permission_overrides or
    // reassigning their role can drop their effective APPROVE_DOCUMENTS the
    // same way deactivating them does above (see the affectedWorkflowNames
    // block in DELETE) — but this path had no equivalent check at all.
    // getMembersWithRole() now filters on live effective_permissions (fix
    // round, section-11 finding), so a member who loses APPROVE_DOCUMENTS
    // here correctly drops out of "reachable" and the stall cron's
    // zero-recipients escalation fires as intended — this warning is now
    // purely a heads-up for the admin making the change, not the only
    // safety net against a silently-stuck step.
    let affectedWorkflowNames: string[] = []
    if (targetMember && simulatedPerms && targetMember.effective_permissions?.['APPROVE_DOCUMENTS'] === true && simulatedPerms['APPROVE_DOCUMENTS'] !== true && targetMember.user_id) {
      const { data: affectedSteps } = await (service as any)
        .from('approval_workflow_steps')
        .select('id, approval_workflows!inner(name, is_active)')
        .eq('approver_user_id', targetMember.user_id)
        .eq('approval_workflows.workspace_id', session.workspaceId)
        .eq('approval_workflows.is_active', true)
      affectedWorkflowNames = Array.from(new Set((affectedSteps || []).map((s: any) => s.approval_workflows?.name).filter(Boolean)))
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: body.permissionOverrides ? 'member.permission_overridden' : 'member.role_changed',
      entityType: 'workspace_member', entityId: id, entityName: targetMember?.users?.name || targetMember?.users?.email || '',
      metadata: affectedWorkflowNames.length ? { ...body, orphaned_approval_workflows: affectedWorkflowNames } : body,
    })

    // FEATURE (Notifications & email fix round): a role or permission change used to be silent — the
    // person only found out when something stopped working. Always sent (not a preference).
    if (targetMember?.user_id && targetMember.user_id !== session.id) {
      await notifyUsers(service, {
        workspaceId: session.workspaceId, recipientIds: [targetMember.user_id],
        type: 'member_role_changed', title: 'Your access changed',
        body: newRoleName ? `${session.name} changed your role to ${newRoleName}.` : `${session.name} adjusted your permissions.`,
        entityType: 'team',
      })
      const email = (targetMember as any).users?.email
      if (email) {
        await checkedSend(() => sendMemberRoleChangedEmail({
          to: email, name: (targetMember as any).users?.name || '', agencyName: session.agencyName,
          roleName: newRoleName, changedByName: session.name,
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
    // FIX (deep audit, Team & Invites re-pass): same info-disclosure
    // pattern fixed on DELETE above — this PATCH catch-all was missed too.
    console.error('Team member PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
