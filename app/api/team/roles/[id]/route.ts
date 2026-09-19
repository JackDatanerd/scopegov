// app/api/team/roles/[id]/route.ts  (NEW FILE — C13)

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { permissionsBeyondCeiling, permissionsBeyondActorForTarget } from '@/lib/utils/permission-ceiling'
import { mergePermissions, protectedPermissionsOrphanedBy, describeProtectedPermission, PROTECTED_PERMISSIONS } from '@/lib/utils/admin-floor'
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

    const { permissions, name, description, isDefault } = await request.json()

    // A null/non-object `permissions` reached `permissions['MANAGE_ROLES']`
    // below and threw a TypeError into the catch-all, surfacing as a 500
    // where a 400 belongs. Not client-reachable; still the wrong answer.
    if (permissions !== undefined && (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions))) {
      return NextResponse.json({ error: 'Invalid permissions payload' }, { status: 400 })
    }
    // FIX (deep audit, Team & Invites section): PATCH applied `if (name)`
    // with no trim and no length cap at all — unlike POST, which at least
    // trims, and unlike every comparable field in the codebase (042 caps
    // users.name; sanitizeDisplayName caps agency/workspace names at 120).
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return NextResponse.json({ error: 'Role name required' }, { status: 400 })
      }
      if (name.trim().length > 60) {
        return NextResponse.json({ error: 'Role name must be under 60 characters' }, { status: 400 })
      }
    }
    // FIX (build, Team & Invites section — validation gap): same gap as
    // POST /api/team/roles — description had no type check or length cap
    // here either. See that route's own comment for the full reasoning;
    // kept as the same 300-char limit so the two can't drift apart.
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return NextResponse.json({ error: 'Invalid description' }, { status: 400 })
    }
    if (typeof description === 'string' && description.trim().length > 300) {
      return NextResponse.json({ error: 'Role description must be under 300 characters' }, { status: 400 })
    }

    const service = createServiceClient()

    // FIX (deep audit, Team & Invites re-pass): fetched unconditionally
    // now (previously only when `permissions` was in the body) so a
    // name/description-only edit also 404s on a nonexistent-or-other-
    // workspace role instead of silently updating zero rows and reporting
    // ok:true, and so the role's name is available below for the audit
    // log regardless of which fields changed.
    const { data: existingRole } = await (service as any)
      .from('roles').select('name, permissions, is_default').eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (!existingRole) return NextResponse.json({ error: 'Role not found' }, { status: 404 })

    // FIX (deep audit, Team & Invites re-pass — feature gap): isDefault
    // was accepted at role CREATION only (POST /api/team/roles) — this
    // route never read it at all, and the frontend hid the Edit button
    // outright for whichever role currently had is_default = true. Net
    // effect: once a role became the workspace default, nothing about it
    // — not its permissions, not its name, not even WHICH role holds the
    // title — could ever be changed again short of creating a brand-new
    // role and marking that one default instead, leaving the old one an
    // orphaned non-default role. `isDefault: false` on the currently-
    // default role is rejected rather than silently ignored — there's
    // always exactly one default role (roles_one_default, migration 001);
    // removing the title requires naming a replacement, same as DELETE
    // already requires below.
    // Same uniqueness rule POST enforces — a rename can collide just as
    // easily as a creation, and the ambiguity it creates in the approver
    // pickers is identical.
    if (name !== undefined && name.trim().toLowerCase() !== (existingRole.name || '').toLowerCase()) {
      const { data: nameClash } = await (service as any)
        .from('roles').select('id').eq('workspace_id', session.workspaceId)
        .ilike('name', name.trim()).neq('id', id).maybeSingle()
      if (nameClash)
        return NextResponse.json({ error: 'A role with that name already exists in this workspace' }, { status: 409 })
    }

    if (isDefault === false && existingRole.is_default) {
      return NextResponse.json({
        error: 'Every workspace needs a default role. Make a different role the default first, rather than unsetting this one.',
      }, { status: 409 })
    }

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
    // sole MANAGE_ROLES/MANAGE_WORKSPACE_SETTINGS holder can never leave
    // and orphan the permission system — "a one-way lockout of the
    // permission system itself, with no self-service recovery" (034's own
    // words), enforced there by locking every active workspace_members
    // row (FOR UPDATE) before checking. Editing a role's permissions in
    // place reaches the exact same end state — trg_role_permissions_
    // propagate (migration 001) recomputes effective_permissions for
    // every member holding this role the instant it's saved — but this
    // pre-check is a plain SELECT with no lock and no transaction tying
    // it to the write below. Two concurrent MANAGE_ROLES-holder requests
    // (two co-admins, or a doubled-up submit) can each read this same
    // pre-change snapshot, both see someone else still holds it, and both
    // proceed — jointly orphaning the workspace. Kept here as a fast,
    // friendly pre-check (good error message before ever touching the
    // database) but it is NOT the actual gate: migration 055's
    // update_role_permissions_atomic re-runs the identical check inside a
    // transaction that locks the workspace's active membership first, so
    // a second concurrent call re-evaluates against real post-commit
    // state instead of the same stale read this block used. See that
    // migration's comment for a from-scratch, empirically-raced
    // reproduction of exactly this failure mode and its fix.
    if (permissions !== undefined && permissions !== null) {
      const losing = PROTECTED_PERMISSIONS.filter(
        perm => existingRole.permissions?.[perm] === true && permissions[perm] !== true
      )
      if (losing.length > 0) {
        const { data: activeMembers } = await (service as any)
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

    // `permissions` goes through the atomic RPC (the real, race-proof
    // gate — see the long comment above); name/description are a plain
    // update, same as before. Two calls instead of one, same trade-off
    // this file already accepts for the default-role swap below
    // (defaultSwapFailed): if the second call fails, the permissions
    // change already landed and name/description just didn't — reported
    // rather than silently dropped.
    if (permissions !== undefined) {
      const { error: rpcError } = await (service as any).rpc('update_role_permissions_atomic', {
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

    const otherUpdates: Record<string, unknown> = {}
    if (name)        otherUpdates.name        = name.trim()
    // FIX (build, Team & Invites section): wrote `description` raw, with
    // no trim — inconsistent with POST /api/team/roles, which already
    // trims (and, same as `name` here, with the untrimmed value counting
    // against the 300-char cap just added above, so " ".repeat(301) would
    // pass validation and still land in the DB untrimmed).
    if (description !== undefined) otherUpdates.description = typeof description === 'string' ? description.trim() || null : description

    if (Object.keys(otherUpdates).length > 0 || permissions === undefined) {
      otherUpdates.updated_at = new Date().toISOString()
      const { error } = await (service as any)
        .from('roles')
        .update(otherUpdates)
        .eq('id', id)
        .eq('workspace_id', session.workspaceId) // scope to workspace — never cross-tenant

      if (error) throw new Error(error.message)
    }

    // FIX (deep audit, Team & Invites re-pass — feature gap, continued):
    // promote this role to default via the same atomic swap role
    // creation uses (migration 049) — never two separate non-transactional
    // statements, for the same "workspace briefly has zero default roles"
    // reason documented there. Only fires when it's actually a change;
    // re-sending isDefault: true on the role that's already default is a
    // harmless no-op, not a wasted RPC call.
    let defaultSwapFailed = false
    if (isDefault === true && !existingRole.is_default) {
      const { error: defaultErr } = await (service as any).rpc('set_default_role_atomic', {
        p_workspace_id: session.workspaceId, p_new_role_id: id,
      })
      if (defaultErr) {
        console.error('set_default_role_atomic failed:', defaultErr)
        defaultSwapFailed = true
      }
    }

    // FIX (section-11 audit): stripping APPROVE_DOCUMENTS from a role here
    // silently breaks any active workflow step that assigns it.
    // getMembersWithRole() now filters on live effective_permissions (fix
    // round, section-11 finding) instead of matching on role_id alone, so
    // this correctly drops to zero recipients and the stall cron's
    // escalation fires — this warning is a heads-up at edit time, not the
    // only thing standing between this change and a silently-stuck step.
    // DELETE below already checks this for role deletion; edits had no
    // equivalent warning. Warn rather than block, matching the
    // member-deactivation pattern.
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
        fields: [
          ...Object.keys(otherUpdates).filter(k => k !== 'updated_at'),
          ...(permissions !== undefined ? ['permissions'] : []),
        ],
        ...(affectedWorkflowNames.length ? { orphaned_approval_workflows: affectedWorkflowNames } : {}),
        ...(isDefault === true ? { requested_default: true, default_swap_failed: defaultSwapFailed } : {}),
      },
    })

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
    // FIX (deep audit, Team & Invites re-pass): raw exception messages
    // were returned straight to the client — same info-disclosure pattern
    // already fixed elsewhere. Log server-side only.
    console.error('Team roles PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
    console.error('Team roles DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
