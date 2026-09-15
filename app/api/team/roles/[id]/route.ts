// app/api/team/roles/[id]/route.ts  (NEW FILE — C13)

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { permissionsBeyondCeiling, permissionsBeyondActorForTarget } from '@/lib/utils/permission-ceiling'

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
      const { data: existingRole } = await (service as any)
        .from('roles').select('permissions').eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!existingRole) return NextResponse.json({ error: 'Role not found' }, { status: 404 })

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
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}
