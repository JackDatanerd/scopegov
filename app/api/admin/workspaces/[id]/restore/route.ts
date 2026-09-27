import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { resumePaystackSubscription } from '@/lib/integrations/paystack'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { data: workspace } = await (service as any)
    .from('workspaces').select('id, name, agency_name, deleted_at').eq('id', params.id).maybeSingle()
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  if (!workspace.deleted_at) return NextResponse.json({ error: 'Not suspended' }, { status: 409 })

  const { error } = await (service as any).rpc('admin_restore_workspace', { p_workspace_id: params.id })
  if (error) {
    console.error('[admin] restore workspace failed:', error.message)
    return NextResponse.json({ error: 'Could not restore workspace' }, { status: 500 })
  }

  const { data: billing } = await (service as any).from('billing').select('*').eq('workspace_id', params.id).maybeSingle()
  const resumeResult = await resumePaystackSubscription(billing)
  if (!resumeResult.ok) {
    console.error('[admin] Paystack resume on restore failed:', resumeResult.error)
  }

  await logAdminAction(service, {
    actor,
    eventType: 'workspace.restored',
    targetType: 'workspace',
    targetId: workspace.id,
    targetLabel: workspace.agency_name || workspace.name,
    metadata: { paystackResumeOk: resumeResult.ok },
  })

  return NextResponse.json({ ok: true })
}
