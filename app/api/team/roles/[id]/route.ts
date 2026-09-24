// app/api/team/roles/[id]/route.ts

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { permissionsBeyondCeiling, permissionsBeyondActorForTarget } from '@/lib/utils/permission-ceiling'
import { parsePermissionMap } from '@/lib/utils/permission-map'
import { mergePermissions, protectedPermissionsOrphanedBy, describeProtectedPermission, PROTECTED_PERMISSIONS, approvalPermissionOrphanedBy, APPROVE_DOCUMENTS_ORPHAN_MESSAGE } from '@/lib/utils/admin-floor'
import { workspaceOwnerId } from '@/lib/utils/owner-protection'
import { roleNameTaken } from '@/lib/utils/role-names'
import { diffPermissionMaps } from '@/lib/utils/permission-diff'
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

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const { permissions: rawPermissions, name, description, isDefault } = body as Record<string, any>

    // Permission values must be real booleans; unknown keys are dropped.
    let permissions: Record<string, boolean> | undefined = undefined
    if (rawPermissions !== undefined) {
      const parsed = parsePermissionMap(rawPermissions)
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
      permissions = parsed.value
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim())
        return NextResponse.json({ error: 'Role name required' }, { status: 400 })
      if (name.trim().length > 60)
        return NextResponse.json({ error: 'Role name must be under 60 characters' }, { status: 400 })
    }
    if (description !== undefined && description !== null && typeof description !== 'string')
      return NextResponse.json({ error: 'Invalid description' }, { status: 400 })
    if (typeof description === 'string' && description.trim().length > 300)
      return NextResponse.json({ error: 'Role description must be under 300 characters' }, { status: 400 })
    if (isDefault !== undefined && typeof isDefault !== 'boolean')
      return NextResponse.json({ error: 'isDefault must be true or false' }, { status: 400 })

    if (permissions === undefined && name === undefined && description === undefined && isDefault === undefined)
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

    const service = createServiceClient() as any

    const { data: existingRole } = await service
      .from('roles').select('name, description, permissions, is_default').eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (!existingRole) return NextResponse.json({ error: 'Role not found' }, { status: 404 })

    // The Edit role form always sends the role's full permission map, even when only the name or
    // description was changed. Every permission-specific gate below (owner protection, ceiling,
    // orphan floors, the atomic RPC) exists for permission CHANGES — an unchanged map is treated as
    // not sent, so renaming a role that a co-admin or the owner also holds isn't blocked by a
    // "permissions can't be changed" refusal that has nothing to do with what was edited.
    if (permissions !== undefined) {
      const d = diffPermissionMaps(existingRole.permissions, permissions)
      if (d.granted.length === 0 && d.revoked.length === 0) permissions = undefined
    }
    if (permissions === undefined && name === undefined && description === undefined && isDefault === undefined)
      return NextResponse.json({ ok: true, unchanged: true })

    // Floor check for EVERY change to a role — its permissions, its name or
    // description, and making it the workspace default. A role that currently
    // holds anything the actor doesn't hold can't be edited, renamed or
    // promoted by them: promoting it to default would hand those permissions
    // to everyone invited without an explicit role.
    const outOfReach = permissionsBeyondActorForTarget(session, existingRole.permissions)
    if (outOfReach.length > 0)
      return NextResponse.json({
        error: `Cannot modify a role that holds permissions you don't hold yourself: ${outOfReach.join(', ')}`,
      }, { status: 403 })

    if (name !== undefined && name.trim().toLowerCase() !== (existingRole.name || '').trim().toLowerCase()) {
      const { data: others } = await service.from('roles').select('id,name').eq('workspace_id', session.workspaceId)
      if (roleNameTaken(others || [], name, id))
        return NextResponse.json({ error: 'A role with that name already exists in this workspace' }, { status: 409 })
    }

    if (isDefault === false && existingRole.is_default) {
      return NextResponse.json({
        error: 'Every workspace needs a default role. Make a different role the default first, rather than unsetting this one.',
      }, { status: 409 })
    }

    // FIX (deep audit, Settings + Team re-pass round 2 — MEDIUM): owner
    // protection (lib/utils/owner-protection.ts) stops anyone but the owner
    // themselves from touching the owner's role_id or permission_overrides
    // directly — but this route edits a ROLE, not a member, and a role is
    // often held by several people at once. Editing the role the owner
    // happens to hold reaches the exact same end state — the owner's
    // effective permissions change — through a door owner-protection never
    // watches, and permissionsBeyondActorForTarget/protectedPermissionsOrphanedBy
    // above don't help either: an actor editing within their OWN ceiling, who
    // still personally holds every permission being stripped (just via a
    // different role than the owner's), sails through both checks even
    // though the owner they're not supposed to be able to touch just lost
    // access. Same restriction as owner-protection's own: only the owner can
    // change what their own role grants; anyone else has to ask them to do
    // it, or use transfer-ownership first.
    if (permissions !== undefined) {
      const ownerId = await workspaceOwnerId(service, session.workspaceId)
      if (ownerId && ownerId !== session.id) {
        const { data: ownerHoldsRole } = await service
          .from('workspace_members').select('id')
          .eq('workspace_id', session.workspaceId).eq('user_id', ownerId).eq('role_id', id).eq('status', 'active')
          .maybeSingle()
        if (ownerHoldsRole) {
          return NextResponse.json({
            error: 'This role belongs to the workspace owner, so its permissions can\u2019t be changed by anyone else. Ask the owner to make this change, or have them hand ownership over from Settings \u2192 Danger zone first.',
          }, { status: 403 })
        }
      }
    }

    if (permissions !== undefined) {
      const beyond = permissionsBeyondCeiling(session, permissions)
      if (beyond.length > 0)
        return NextResponse.json({
          error: `Cannot grant permissions you don't hold yourself: ${beyond.join(', ')}`,
        }, { status: 403 })

      // Friendly pre-check; update_role_permissions_atomic below is the real gate.
      const losing = PROTECTED_PERMISSIONS.filter(
        perm => existingRole.permissions?.[perm] === true && permissions![perm] !== true
      )
      if (losing.length > 0) {
        const { data: activeMembers } = await service
          .from('workspace_members').select('id,role_id,permission_overrides,effective_permissions')
          .eq('workspace_id', session.workspaceId).eq('status', 'active')

        const snapshot = (activeMembers || []).map((m: any) => ({ id: m.id, effectivePermissions: m.effective_permissions }))
        const simulated = new Map<string, Record<string, unknown> | null>(
          (activeMembers || [])
            .filter((m: any) => m.role_id === id)
            .map((m: any): [string, Record<string, unknown> | null] => [m.id, mergePermissions(permissions, m.permission_overrides)])
        )
        const orphaned = protectedPermissionsOrphanedBy(snapshot, simulated)
        if (orphaned.length > 0) {
          const label = orphaned.map(describeProtectedPermission).join(' or ')
          return NextResponse.json({
            error: `This would leave the workspace with no one who can ${label}. Grant ${orphaned.join(' / ')} to another member or role first — once nobody holds it, nobody can grant it back.`,
          }, { status: 409 })
        }
      }
    }

    // Application-layer floor for APPROVE_DOCUMENTS — see approvalPermissionOrphanedBy.
    if (permissions !== undefined && permissions !== null &&
        existingRole.permissions?.['APPROVE_DOCUMENTS'] === true && permissions['APPROVE_DOCUMENTS'] !== true) {
      const { data: approvalMembers } = await service
        .from('workspace_members').select('id,role_id,permission_overrides,effective_permissions')
        .eq('workspace_id', session.workspaceId).eq('status', 'active')
      const approvalSnapshot = (approvalMembers || []).map((m: any) => ({ id: m.id, effectivePermissions: m.effective_permissions }))
      const approvalSimulated = new Map<string, Record<string, unknown> | null>(
        (approvalMembers || [])
          .filter((m: any) => m.role_id === id)
          .map((m: any): [string, Record<string, unknown> | null] => [m.id, mergePermissions(permissions, m.permission_overrides)])
      )
      if (approvalPermissionOrphanedBy(approvalSnapshot, approvalSimulated))
        return NextResponse.json({ error: APPROVE_DOCUMENTS_ORPHAN_MESSAGE }, { status: 409 })

      // FIX (re-audit, section-11 finding): the check above only catches a
      // WORKSPACE-WIDE loss of APPROVE_DOCUMENTS. It says nothing about THIS
      // role specifically being the assigned approver on a request that's
      // already waiting on a decision — if some other role still holds the
      // permission, the edit sails through even though every holder of
      // THIS role can no longer decide their own assigned step the moment
      // it lands (hasPermission fails first, before the role/user match is
      // even checked). That's the exact dead-end the DELETE handler below
      // already refuses to create (see its own liveApprovalSteps check) —
      // revoking the permission via PATCH has the identical effect on a
      // live step as deleting the role outright, so it needs the same
      // guard.
      const { count: liveApprovalSteps } = await service
        .from('approval_steps')
        .select('id, approval_requests!inner(workspace_id, status)', { count: 'exact', head: true })
        .eq('approver_role_id', id).eq('status', 'pending')
        .eq('approval_requests.workspace_id', session.workspaceId).eq('approval_requests.status', 'pending')
      if ((liveApprovalSteps || 0) > 0) {
        return NextResponse.json({
          error: `This role is the current approver on ${liveApprovalSteps} approval request${liveApprovalSteps === 1 ? '' : 's'} still waiting for a decision. Reassign or cancel ${liveApprovalSteps === 1 ? 'it' : 'them'} from the Approvals page first, or leave Approve documents on this role until they clear.`,
        }, { status: 409 })
      }
    }

    if (permissions !== undefined) {
      const { error: rpcError } = await service.rpc('update_role_permissions_atomic', {
        p_workspace_id: session.workspaceId, p_role_id: id, p_permissions: permissions,
      })
      if (rpcError) {
        if (rpcError.message?.startsWith('would_orphan_permissions:')) {
          const orphaned = rpcError.message.split(':')[1].split(',') as (typeof PROTECTED_PERMISSIONS)[number][]
          const label = orphaned.map(describeProtectedPermission).join(' or ')
          return NextResponse.json({
            error: `This would leave the workspace with no one who can ${label}. Grant ${orphaned.join(' / ')} to another member or role first — once nobody holds it, nobody can grant it back.`,
          }, { status: 409 })
        }
        throw new Error(rpcError.message)
      }
    }

    const newName = name !== undefined ? name.trim() : undefined
    const newDescription = description !== undefined
      ? (typeof description === 'string' ? description.trim() || null : null)
      : undefined
    const otherUpdates: Record<string, unknown> = {}
    if (newName !== undefined && newName !== existingRole.name) otherUpdates.name = newName
    if (newDescription !== undefined && newDescription !== (existingRole.description ?? null)) otherUpdates.description = newDescription

    if (Object.keys(otherUpdates).length > 0) {
      otherUpdates.updated_at = new Date().toISOString()
      const { error } = await service
        .from('roles').update(otherUpdates).eq('id', id)
        .eq('workspace_id', session.workspaceId)
      if (error) {
        if ((error as any).code === '23505')
          return NextResponse.json({ error: 'A role with that name already exists in this workspace' }, { status: 409 })
        throw new Error(error.message)
      }
    }

    // Promote to default with the same atomic swap role creation uses.
    let defaultSwapFailed = false
    let previousDefaultName: string | null = null
    if (isDefault === true && !existingRole.is_default) {
      const { data: prev } = await service
        .from('roles').select('name').eq('workspace_id', session.workspaceId).eq('is_default', true).maybeSingle()
      previousDefaultName = prev?.name ?? null
      const { error: defaultErr } = await service.rpc('set_default_role_atomic', {
        p_workspace_id: session.workspaceId, p_new_role_id: id,
      })
      if (defaultErr) {
        console.error('set_default_role_atomic failed:', defaultErr)
        defaultSwapFailed = true
      }
    }

    // Stripping APPROVE_DOCUMENTS from a role silently breaks workflow steps
    // that assign it — warn at edit time.
    let affectedWorkflowNames: string[] = []
    if (permissions !== undefined && existingRole.permissions?.['APPROVE_DOCUMENTS'] === true && permissions['APPROVE_DOCUMENTS'] !== true) {
      const { data: affectedSteps } = await service
        .from('approval_workflow_steps')
        .select('id, approval_workflows!inner(name, is_active)')
        .eq('approver_role_id', id)
        .eq('approval_workflows.workspace_id', session.workspaceId)
        .eq('approval_workflows.is_active', true)
      affectedWorkflowNames = Array.from(new Set((affectedSteps || []).map((s: any) => s.approval_workflows?.name).filter(Boolean))) as string[]
    }

    const permChange = permissions !== undefined ? diffPermissionMaps(existingRole.permissions, permissions) : { granted: [], revoked: [] }
    const contentChanged = Object.keys(otherUpdates).length > 0 || permChange.granted.length > 0 || permChange.revoked.length > 0
    if (contentChanged) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'role.updated', entityType: 'role',
        entityId: id, entityName: newName || existingRole.name,
        metadata: {
          ...(otherUpdates.name ? { name: { from: existingRole.name, to: otherUpdates.name } } : {}),
          ...('description' in otherUpdates ? { description_changed: true } : {}),
          ...(permChange.granted.length ? { permissions_granted: permChange.granted } : {}),
          ...(permChange.revoked.length ? { permissions_revoked: permChange.revoked } : {}),
          ...(affectedWorkflowNames.length ? { orphaned_approval_workflows: affectedWorkflowNames } : {}),
        },
      })
    }
    if (isDefault === true && !existingRole.is_default) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'role.default_changed', entityType: 'role',
        entityId: id, entityName: newName || existingRole.name,
        metadata: { from_role: previousDefaultName, to_role: newName || existingRole.name, swap_failed: defaultSwapFailed },
      })
    }

    return NextResponse.json({
      ok: true,
      ...(affectedWorkflowNames.length ? {
        warning: `This role is named as an approver on: ${affectedWorkflowNames.join(', ')}. Holders of this role may no longer be able to act on those steps — update those workflows in Settings so documents don't get stuck waiting.`,
      } : {}),
      ...(defaultSwapFailed ? {
        defaultWarning: 'Your other changes were saved, but this role could not be set as the default — try again.',
      } : {}),
    })
  } catch (err) {
    console.error('Team roles PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Deleting a role is refused wherever it would break something: a role still
// held by a member (active, pending OR deactivated), the workspace default, or
// a role named as an approver in a workflow.
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

    const service = createServiceClient() as any
    const { data: role } = await service
      .from('roles').select('id, name, is_default, permissions')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })

    if (role.is_default) {
      return NextResponse.json({
        error: 'This is the workspace\u2019s default role and can\u2019t be deleted. Make another role the default first.',
      }, { status: 409 })
    }

    const outOfReach = permissionsBeyondActorForTarget(session, role.permissions)
    if (outOfReach.length > 0) {
      return NextResponse.json({
        error: `Cannot delete a role that holds permissions you don't hold yourself: ${outOfReach.join(', ')}`,
      }, { status: 403 })
    }

    const { data: holders } = await service
      .from('workspace_members').select('id,status')
      .eq('workspace_id', session.workspaceId).eq('role_id', id)
    const live        = (holders || []).filter((m: any) => m.status === 'active').length
    const pending     = (holders || []).filter((m: any) => m.status === 'invited' || m.status === 'expired').length
    const deactivated = (holders || []).filter((m: any) => m.status === 'deactivated').length
    if (live > 0) {
      return NextResponse.json({
        error: `${live} active member${live === 1 ? '' : 's'} currently hold this role. Reassign them first.`,
      }, { status: 409 })
    }
    if (pending > 0) {
      return NextResponse.json({
        error: `${pending} pending or expired invite${pending === 1 ? '' : 's'} still use this role. Revoke ${pending === 1 ? 'it' : 'them'} or change ${pending === 1 ? 'its' : 'their'} role first.`,
      }, { status: 409 })
    }
    if (deactivated > 0) {
      return NextResponse.json({
        error: `${deactivated} deactivated member${deactivated === 1 ? '' : 's'} still hold this role. Change ${deactivated === 1 ? 'their' : 'their'} role from the Deactivated list on the Members tab first, so reactivating ${deactivated === 1 ? 'them' : 'them'} later doesn't leave anyone with no role.`,
      }, { status: 409 })
    }

    const { count: stepCount } = await service
      .from('approval_workflow_steps').select('id', { count: 'exact', head: true })
      .eq('approver_role_id', id)
    if ((stepCount || 0) > 0) {
      return NextResponse.json({
        error: 'This role is used as an approver in one or more approval workflows. Update those workflows first.',
      }, { status: 409 })
    }

    // FIX (section-11 audit, pass 2): a role that is the CURRENT approver on a
    // request still waiting for a decision can't simply vanish — the step would
    // be left with no approver at all. (The FK from approval_steps to roles had
    // no ON DELETE rule either, so a role that had EVER appeared in a finished
    // request could never be deleted, and the failure surfaced as a bare 500;
    // migration 069 makes historical steps SET NULL.)
    const { count: liveApprovalSteps } = await service
      .from('approval_steps')
      .select('id, approval_requests!inner(workspace_id, status)', { count: 'exact', head: true })
      .eq('approver_role_id', id).eq('status', 'pending')
      .eq('approval_requests.workspace_id', session.workspaceId).eq('approval_requests.status', 'pending')
    if ((liveApprovalSteps || 0) > 0) {
      return NextResponse.json({
        error: `This role is the current approver on ${liveApprovalSteps} approval request${liveApprovalSteps === 1 ? '' : 's'} still waiting for a decision. Reassign or cancel ${liveApprovalSteps === 1 ? 'it' : 'them'} from the Approvals page first.`,
      }, { status: 409 })
    }

    const { error } = await service
      .from('roles').delete().eq('id', id).eq('workspace_id', session.workspaceId)
    if (error) {
      if ((error as any).code === '23503')
        return NextResponse.json({ error: 'This role is still assigned to someone. Reassign them first.' }, { status: 409 })
      throw new Error(error.message)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'role.deleted', entityType: 'role',
      entityId: id, entityName: role.name, metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Team roles DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
