// app/api/team/roles/[id]/route.ts  (NEW FILE — C13)

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { permissionsBeyondCeiling } from '@/lib/utils/permission-ceiling'

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

    const service = createServiceClient()

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
