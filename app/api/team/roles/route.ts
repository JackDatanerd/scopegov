import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { permissionsBeyondCeiling } from '@/lib/utils/permission-ceiling'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_ROLES'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_ROLES' }, { status: 403 })

    // Custom roles are Pro/Agency only
    if (!['pro','agency','trial'].includes(session.planTier))
      return NextResponse.json({ error: 'Custom roles require Pro or Agency plan' }, { status: 403 })

    const { name, description, permissions, isDefault } = await request.json()
    if (!name?.trim()) return NextResponse.json({ error: 'Role name required' }, { status: 400 })

    // FIX (audit round 4, finding #1): MANAGE_ROLES let you shape the
    // workspace's role structure — it was never meant to let you mint a
    // role with permissions you don't personally hold and then assign it
    // to yourself. You can only grant what you already have.
    const beyond = permissionsBeyondCeiling(session, permissions)
    if (beyond.length > 0)
      return NextResponse.json({
        error: `Cannot grant permissions you don't hold yourself: ${beyond.join(', ')}`,
      }, { status: 403 })

    const service = createServiceClient()

    // FIX (deep audit, Team & Invites re-pass — CRITICAL): this used to
    // unset the old default with one UPDATE, then insert the new role as
    // default with a second, entirely separate statement. If the insert
    // failed for any reason after the unset landed (a validation error,
    // a transient DB blip), the workspace was left with ZERO default
    // roles — see migration 049 for the traced downstream consequence
    // (a member joining mid-race gets activated with no role and no
    // permissions at all, silently). Always insert the new role as
    // non-default first; if isDefault was requested, promote it via
    // set_default_role_atomic (migration 049), which unsets the old one
    // and sets the new one in a single transaction. Worst case now if
    // that second step fails: the role exists but isn't (yet) the
    // default — recoverable and visible, never a workspace with none.
    const { data: role, error } = await (service as any).from('roles').insert({
      workspace_id: session.workspaceId,
      name:         name.trim(),
      description:  description?.trim() || null,
      permissions:  permissions || {},
      is_default:   false,
      created_by:   session.id,
    }).select('id').single()

    if (error) throw new Error(error.message)

    let defaultSwapFailed = false
    if (isDefault) {
      const { error: defaultErr } = await (service as any).rpc('set_default_role_atomic', {
        p_workspace_id: session.workspaceId, p_new_role_id: role.id,
      })
      if (defaultErr) {
        console.error('set_default_role_atomic failed:', defaultErr)
        defaultSwapFailed = true
      }
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.role_created', entityType: 'role',
      entityId: role.id, entityName: name,
      metadata: isDefault ? { requested_default: true, default_swap_failed: defaultSwapFailed } : {},
    })

    return NextResponse.json({
      roleId: role.id,
      ...(defaultSwapFailed ? { warning: 'Role created, but it could not be set as the default — try again from the role list.' } : {}),
    })
  } catch (err) {
    // FIX (deep audit, Team & Invites re-pass): raw exception messages
    // (including error.message re-thrown above) were returned straight to
    // the client — same info-disclosure pattern already fixed elsewhere.
    console.error('Team roles POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()
    const { data: roles } = await (service as any)
      .from('roles').select('id,name,description,permissions,is_default')
      .eq('workspace_id', session.workspaceId).order('name')
    return NextResponse.json({ roles: roles || [] })
  } catch {
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}
