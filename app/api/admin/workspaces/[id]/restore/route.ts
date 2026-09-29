import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { resumePaystackSubscription } from '@/lib/integrations/paystack'
import { sendWorkspaceRestoredEmail } from '@/lib/email/templates'

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

  // FIX (deep audit, Workspace lifecycle independent re-pass — feature gap):
  // the self-service restore route notifies every member whose access just
  // came back; this admin path (which reactivates the same members) told
  // no one. After the RPC, status='active' members of a workspace that was
  // fully deactivated are exactly the ones this restore reactivated
  // (admin_restore_workspace only reactivates the rows this suspension
  // deactivated — see migration 092).
  const agencyLabel = workspace.agency_name || workspace.name
  let notified = 0
  try {
    const { data: reactivated } = await (service as any)
      .from('workspace_members')
      .select('user_id, user:users(email, name)')
      .eq('workspace_id', params.id).eq('status', 'active')
    for (const m of (reactivated || [])) {
      if (!m?.user?.email) continue
      try {
        // sendEmail resolves { ok: false } on a provider rejection instead of throwing.
        const res = await sendWorkspaceRestoredEmail({
          to: m.user.email, name: m.user.name || m.user.email, agencyName: agencyLabel,
          restoredByName: 'The ScopeGov team', isRestorer: false, workspaceId: params.id,
        })
        if (res && res.ok === false) console.error('[admin] Workspace restored email rejected for', m.user.email, res.error)
        else if (!res || !res.skipped) notified++
      } catch (e) {
        console.error('[admin] Workspace restored email failed for', m.user.email, e)
      }
    }
  } catch (e) { console.error('[admin] Workspace restored notification sweep failed (non-fatal):', e) }

  await logAdminAction(service, {
    actor,
    eventType: 'workspace.restored',
    targetType: 'workspace',
    targetId: workspace.id,
    targetLabel: workspace.agency_name || workspace.name,
    metadata: { paystackResumeOk: resumeResult.ok, membersNotified: notified },
  })

  return NextResponse.json({ ok: true })
}
