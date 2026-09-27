import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure } from '@/lib/auth/admin'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin()
  if (isAdminGuardFailure(guard)) return guard
  const { service } = guard

  const [{ data: workspace, error: wErr }, { data: members }, { data: billing }, { data: recentActivity }, { data: projectCounts }] = await Promise.all([
    (service as any).from('workspaces').select('*').eq('id', params.id).maybeSingle(),
    (service as any)
      .from('workspace_members')
      .select('id, status, created_at, users:user_id (id, email, name), roles:role_id (name)')
      .eq('workspace_id', params.id)
      .order('created_at', { ascending: true }),
    (service as any).from('billing').select('*').eq('workspace_id', params.id).maybeSingle(),
    (service as any)
      .from('audit_log')
      .select('id, event_type, entity_type, entity_name, actor_name, actor_email, created_at')
      .eq('workspace_id', params.id)
      .order('created_at', { ascending: false })
      .limit(25),
    (service as any).from('projects').select('status').eq('workspace_id', params.id),
  ])

  if (wErr || !workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  }

  // jwt_secret never leaves this route (BUG-062 convention this whole
  // codebase already follows for every other consumer of this table).
  delete (workspace as any).jwt_secret

  const projectsByStatus: Record<string, number> = {}
  for (const p of projectCounts || []) projectsByStatus[p.status] = (projectsByStatus[p.status] || 0) + 1

  return NextResponse.json({
    workspace,
    members: members || [],
    billing: billing || null,
    recentActivity: recentActivity || [],
    projectsByStatus,
  })
}
