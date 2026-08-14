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

    // If setting as default, clear existing default
    if (isDefault) {
      await (service as any).from('roles').update({ is_default: false })
        .eq('workspace_id', session.workspaceId).eq('is_default', true)
    }

    const { data: role, error } = await (service as any).from('roles').insert({
      workspace_id: session.workspaceId,
      name:         name.trim(),
      description:  description?.trim() || null,
      permissions:  permissions || {},
      is_default:   isDefault || false,
      created_by:   session.id,
    }).select('id').single()

    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.role_created', entityType: 'role',
      entityId: role.id, entityName: name, metadata: {},
    })

    return NextResponse.json({ roleId: role.id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
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
