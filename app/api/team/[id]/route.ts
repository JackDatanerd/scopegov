import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { permissionsBeyondCeiling, roleWithinCeiling } from '@/lib/utils/permission-ceiling'

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'INVITE_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission: INVITE_MEMBERS' }, { status: 403 })

    const service = createServiceClient()

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id,user_id,users!workspace_members_user_id_fkey(name,email)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
    if (member.user_id === session.id)
      return NextResponse.json({ error: 'You cannot deactivate yourself' }, { status: 400 })

    const now = new Date().toISOString()

    // Deactivate membership
    await (service as any).from('workspace_members').update({
      status: 'deactivated', deactivated_at: now,
    }).eq('id', id)

    // Remove from all project_members
    await (service as any).from('project_members').delete().eq('member_id', id)

    // Invalidate sessions by deleting auth session — via Supabase Admin
    // (service role can't directly invalidate sessions; member will be blocked on next request via middleware)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'member.deactivated', entityType: 'workspace_member',
      entityId: id, entityName: member.users?.email || '',
      metadata: {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }   = await params
    const session  = await getSession()
    if (!session)  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_ROLES'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_ROLES' }, { status: 403 })

    const body    = await request.json()
    const service = createServiceClient()
    const updates: Record<string, unknown> = {}

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
