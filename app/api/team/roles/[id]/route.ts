// app/api/team/roles/[id]/route.ts  (NEW FILE — C13)

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { permissionsBeyondCeiling, permissionsBeyondActorForTarget } from '@/lib/utils/permission-ceiling'
import { mergePermissions, wouldOrphanManageRoles } from '@/lib/utils/admin-floor'
import { logAudit } from '@/lib/utils/audit'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_ROLES'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_ROLES' }, { status: 403 })

    const { permissions, name, description } = await request.json()

    const service = createServiceClient()

    // FIX (deep audit, Team & Invites re-pass): fetched unconditionally
    // now (previously only when `permissions` was in the body) so a
    // name/description-only edit also 404s on a nonexistent-or-other-
    // workspace role instead of silently updating zero rows and reporting
    // ok:true, and so the role's name is available below for the audit
    // log regardless of which fields changed.
    const { data: existingRole } = await (service as any)
      .from('roles').select('name, permissions').eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (!existingRole) return NextResponse.json({ error: 'Role not found' }, { status: 404 })

    // FIX (section-by-section re-audit, RLS+permissions Finding 2 —
    // CRITICAL): the ceiling check below only ever blocked granting a
    // NEW true permission beyond the actor's own — it never checked what
    // the role CURRENTLY has. Since a `false` entry is never "beyond the
    // ceiling" (that's correct for the grant direction), an actor could
    // submit `{ permissions: { ...every key: false } }` and sail through,
    // zeroing out ANY role — including "Owner" itself, which is just an
    // ordinarily-editable row with no structural protection. Floor check
    // first: you cannot touch a role that currently holds anything you
    // don't hold yourself, full stop, regardless of what you're changing
    // it to.
    if (permissions !== undefined) {
      const outOfReach = permissionsBeyondActorForTarget(session, existingRole.permissions)
      if (outOfReach.length > 0)
        return NextResponse.json({
          error: `Cannot modify a role that holds permissions you don't hold yourself: ${outOfReach.join(', ')}`,
        }, { status: 403 })
    }

    // FIX (audit round 4, finding #1): this edits an EXISTING role in
    // place — and trg_role_permissions_propagate (migration 001)
    // recomputes effective_permissions for every member currently
    // holding it, so an unbounded edit here could silently reshape
    // everyone assigned to the role, including an already-privileged
    // member, or be used to bump the editor's own role past their
    // current ceiling. Same rule as role creation: can't grant what you
    // don't already hold.
    if (permissions !== undefined) {
      const beyond = permissionsBeyondCeiling(session, permissions)
      if (beyond.length > 0)
        return NextResponse.json({
          error: `Cannot grant permissions you don't hold yourself: ${beyond.join(', ')}`,
        }, { status: 403 })
    }

    // FIX (deep audit, RLS+permissions independent re-pass — CRITICAL):
    // leave_workspace_atomic() (027/034/038) exists specifically so the
    // sole MANAGE_ROLES holder can never leave and orphan the permission
    // system — "a one-way lockout of the permission system itself, with
    // no self-service recovery" (034's own words). Editing a role's
    // permissions in place reaches the exact same end state:
    // trg_role_permissions_propagate (migration 001) recomputes
    // effective_permissions for every member currently holding this role
    // the instant it's saved, and the ceiling/floor checks above pass
    // trivially when the editor already holds (and therefore already IS
    // one of the members losing) MANAGE_ROLES. If this role is currently
    // the only source of MANAGE_ROLES workspace-wide, stripping it here
    // zeroes out MANAGE_ROLES for the entire workspace in one save.
    if (permissions !== undefined && existingRole.permissions?.['MANAGE_ROLES'] === true && permissions['MANAGE_ROLES'] !== true) {
      const { data: activeMembers } = await (service as any)
        .from('workspace_members').select('id,role_id,permission_overrides,effective_permissions')
        .eq('workspace_id', session.workspaceId).eq('status', 'active')

      const snapshot = (activeMembers || []).map((m: any) => ({ id: m.id, effectivePermissions: m.effective_permissions }))
      const simulated = new Map<string, Record<string, unknown> | null>(
        (activeMembers || [])
          .filter((m: any) => m.role_id === id)
          .map((m: any): [string, Record<string, unknown> | null] => [m.id, mergePermissions(permissions, m.permission_overrides)])
      )

      if (wouldOrphanManageRoles(snapshot, simulated)) {
        return NextResponse.json({
          error: 'This would leave the workspace with no one who can manage roles. Grant MANAGE_ROLES to another member or role first.',
        }, { status: 409 })
      }
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (permissions !== undefined) updates.permissions = permissions
    if (name)        updates.name        = name
    if (description !== undefined) updates.description = description

    const { error } = await (service as any)
      .from('roles')
      .update(updates)
      .eq('id', id)
      .eq('workspace_id', session.workspaceId) // scope to workspace — never cross-tenant

    if (error) throw new Error(error.message)

    // FIX (section-11 audit): stripping APPROVE_DOCUMENTS from a role here
    // silently breaks any active workflow step that assigns it — everyone
    // who held the role remains "reachable" (getMembersWithRole() and the
    // stall cron only match on role_id, not on live permission), so
    // requests just stall with no visible cause and no escalation, since
    // the stall cron's zero-recipients path never fires. DELETE below
    // already checks this for role deletion; edits had no equivalent.
    // Warn rather than block, matching the member-deactivation pattern.
    let affectedWorkflowNames: string[] = []
    if (permissions !== undefined && existingRole.permissions?.['APPROVE_DOCUMENTS'] === true && permissions['APPROVE_DOCUMENTS'] !== true) {
      const { data: affectedSteps } = await (service as any)
        .from('approval_workflow_steps')
        .select('id, approval_workflows!inner(name, is_active)')
        .eq('approver_role_id', id)
        .eq('approval_workflows.workspace_id', session.workspaceId)
        .eq('approval_workflows.is_active', true)
      affectedWorkflowNames = Array.from(new Set((affectedSteps || []).map((s: any) => s.approval_workflows?.name).filter(Boolean)))
    }

    // FIX (deep audit, Team & Invites re-pass): POST (role_created) and
    // DELETE (role.deleted) right next to this both log to the audit
    // trail — this edit path never did, despite being the most
    // consequential of the three: trg_role_permissions_propagate
    // (migration 001) recomputes effective_permissions for every member
    // currently holding this role the instant it's saved.
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'role.updated', entityType: 'role',
      entityId: id, entityName: (name as string) || existingRole.name,
      metadata: {
        fields: Object.keys(updates).filter(k => k !== 'updated_at'),
        ...(affectedWorkflowNames.length ? { orphaned_approval_workflows: affectedWorkflowNames } : {}),
      },
    })

    return NextResponse.json({
      ok: true,
      ...(affectedWorkflowNames.length ? {
        warning: `This role is named as an approver on: ${affectedWorkflowNames.join(', ')}. Holders of this role may no longer be able to act on those steps — update those workflows in Settings so documents don't get stuck waiting.`,
      } : {}),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}

// FIX (deep audit, section 6): roles could be created but never deleted —
// no endpoint existed at all. Over time every custom role an agency ever
// created, used or not, sat permanently in the workspace. Block deletion
// where it would actually break something (a role currently held by a
// member, or currently the workspace's default/fallback role, or
// currently named as an approver in an active workflow) rather than just
// always refusing — those are real, checkable constraints, not a reason
// to disallow deletion altogether.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_ROLES'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_ROLES' }, { status: 403 })

    const service = createServiceClient()
    const { data: role } = await (service as any)
      .from('roles').select('id, name, is_default, permissions')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })

    if (role.is_default) {
      return NextResponse.json({
        error: 'This is the workspace\u2019s default role and can\u2019t be deleted. Make another role the default first.',
      }, { status: 409 })
    }

    // Same floor check as PATCH above — you can't delete a role that
    // currently holds permissions you don't hold yourself either.
    const outOfReach = permissionsBeyondActorForTarget(session, role.permissions)
    if (outOfReach.length > 0) {
      return NextResponse.json({
        error: `Cannot delete a role that holds permissions you don't hold yourself: ${outOfReach.join(', ')}`,
      }, { status: 403 })
    }

    const { count: memberCount } = await (service as any)
      .from('workspace_members').select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId).eq('role_id', id).neq('status', 'deactivated')
    if ((memberCount || 0) > 0) {
      return NextResponse.json({
        error: `${memberCount} active member${memberCount === 1 ? '' : 's'} currently hold this role. Reassign them first.`,
      }, { status: 409 })
    }

    const { count: stepCount } = await (service as any)
      .from('approval_workflow_steps').select('id', { count: 'exact', head: true })
      .eq('approver_role_id', id)
    if ((stepCount || 0) > 0) {
      return NextResponse.json({
        error: 'This role is used as an approver in one or more approval workflows. Update those workflows first.',
      }, { status: 409 })
    }

    const { error } = await (service as any)
      .from('roles').delete().eq('id', id).eq('workspace_id', session.workspaceId)
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'role.deleted', entityType: 'role',
      entityId: id, entityName: role.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}
