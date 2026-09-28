import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { cancelPaystackSubscription } from '@/lib/integrations/paystack'
import { sendWorkspaceSuspendedEmail } from '@/lib/email/templates'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { data: workspace } = await (service as any)
    .from('workspaces').select('id, name, agency_name, deleted_at').eq('id', params.id).maybeSingle()
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  if (workspace.deleted_at) return NextResponse.json({ error: 'Already suspended' }, { status: 409 })

  const body = await request.json().catch(() => ({})) as { reason?: string }
  const reason = (body.reason || '').trim().slice(0, 500)

  // FIX (deep audit, Workspace lifecycle independent re-pass — feature gap):
  // a suspension ended every member's access with no notice at all (the
  // self-service delete route emails every other member; this one emailed
  // nobody). The recipient list has to be captured BEFORE the RPC below,
  // because admin_suspend_workspace flips every active member to
  // 'deactivated' in the same transaction — reading it afterwards can't
  // tell "was active when suspended" from "left months ago".
  const { data: activeMembers } = await (service as any)
    .from('workspace_members')
    .select('user_id, user:users(email, name)')
    .eq('workspace_id', params.id).eq('status', 'active')

  const { error } = await (service as any).rpc('admin_suspend_workspace', { p_workspace_id: params.id })
  if (error) {
    console.error('[admin] suspend workspace failed:', error.message)
    return NextResponse.json({ error: 'Could not suspend workspace' }, { status: 500 })
  }

  // Best-effort, matching the app's own delete route: a Paystack hiccup
  // must not block the suspension (which already took effect above), but
  // it must be logged, not silently lost.
  const { data: billing } = await (service as any).from('billing').select('*').eq('workspace_id', params.id).maybeSingle()
  const cancelResult = await cancelPaystackSubscription(billing)
  if (!cancelResult.ok) {
    console.error('[admin] Paystack cancel on suspend failed:', cancelResult.error)
  }

  // Best-effort, like the Paystack cancel above: the suspension has
  // already taken effect, so a mail failure must never surface as one.
  const agencyLabel = workspace.agency_name || workspace.name
  let notified = 0
  for (const m of (activeMembers || [])) {
    if (!m?.user?.email) continue
    try {
      await sendWorkspaceSuspendedEmail({
        to: m.user.email, name: m.user.name || m.user.email, agencyName: agencyLabel,
      })
      notified++
    } catch (e) {
      console.error('[admin] Workspace suspended email failed for', m.user.email, e)
    }
  }

  await logAdminAction(service, {
    actor,
    eventType: 'workspace.suspended',
    targetType: 'workspace',
    targetId: workspace.id,
    targetLabel: workspace.agency_name || workspace.name,
    metadata: { reason: reason || null, paystackCancelOk: cancelResult.ok, membersNotified: notified },
  })

  return NextResponse.json({ ok: true })
}
