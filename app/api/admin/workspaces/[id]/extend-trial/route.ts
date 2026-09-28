import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'

const MAX_EXTENSION_DAYS = 365

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const body = await request.json().catch(() => ({})) as { days?: unknown }
  const days = Number(body.days)
  if (!Number.isFinite(days) || !Number.isInteger(days) || days <= 0 || days > MAX_EXTENSION_DAYS) {
    return NextResponse.json({ error: `days must be a whole number between 1 and ${MAX_EXTENSION_DAYS}` }, { status: 400 })
  }

  const { data: workspace } = await (service as any)
    .from('workspaces').select('id, name, agency_name, plan_tier, trial_ends_at').eq('id', params.id).maybeSingle()
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  if (workspace.plan_tier !== 'trial') {
    return NextResponse.json({ error: 'Workspace is not on the trial plan. To start a fresh trial (e.g. after it expired and the workspace moved to Solo), use Change plan → trial.' }, { status: 409 })
  }

  // Extend from whichever is later: the current trial_ends_at (still-active
  // trial) or now (an already-expired trial gets `days` from today, not
  // stacked onto a date already in the past).
  const base = workspace.trial_ends_at && new Date(workspace.trial_ends_at) > new Date()
    ? new Date(workspace.trial_ends_at)
    : new Date()
  const newTrialEndsAt = new Date(base.getTime() + days * 86400_000).toISOString()

  const { error } = await (service as any)
    .from('workspaces')
    .update({ trial_ends_at: newTrialEndsAt, updated_at: new Date().toISOString() })
    .eq('id', params.id)

  if (error) {
    console.error('[admin] extend trial failed:', error.message)
    return NextResponse.json({ error: 'Could not extend trial' }, { status: 500 })
  }

  await logAdminAction(service, {
    actor,
    eventType: 'workspace.trial_extended',
    targetType: 'workspace',
    targetId: workspace.id,
    targetLabel: workspace.agency_name || workspace.name,
    metadata: { days, previousTrialEndsAt: workspace.trial_ends_at, newTrialEndsAt },
  })

  return NextResponse.json({ ok: true, trialEndsAt: newTrialEndsAt })
}
