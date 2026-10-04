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

  const { data: workspace, error: wsErr } = await (service as any)
    .from('workspaces').select('id, name, agency_name, plan_tier, trial_ends_at, deleted_at').eq('id', params.id).maybeSingle()
  if (wsErr) {
    console.error('[admin] extend trial: workspace read failed:', wsErr.message)
    return NextResponse.json({ error: 'Could not load this workspace' }, { status: 500 })
  }
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  if (workspace.deleted_at) {
    return NextResponse.json({ error: 'This workspace is suspended or deleted — restore it before extending its trial.' }, { status: 409 })
  }
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

  // Pinned to the trial state that was read, so two admins extending at once (or a conversion to a paid plan landing
  // in between) cannot both apply — the second one would silently stack on / overwrite the first.
  let upd = (service as any)
    .from('workspaces')
    .update({ trial_ends_at: newTrialEndsAt, updated_at: new Date().toISOString() })
    .eq('id', params.id).eq('plan_tier', 'trial').is('deleted_at', null)
  upd = workspace.trial_ends_at ? upd.eq('trial_ends_at', workspace.trial_ends_at) : upd.is('trial_ends_at', null)
  const { data: changed, error } = await upd.select('id')

  if (error) {
    console.error('[admin] extend trial failed:', error.message)
    return NextResponse.json({ error: 'Could not extend trial' }, { status: 500 })
  }
  if (!changed || changed.length === 0) {
    return NextResponse.json({ error: 'The trial changed while you were editing. Reload and try again.' }, { status: 409 })
  }

  const auditLogged = await logAdminAction(service, {
    actor,
    eventType: 'workspace.trial_extended',
    targetType: 'workspace',
    targetId: workspace.id,
    targetLabel: workspace.agency_name || workspace.name,
    metadata: { days, previousTrialEndsAt: workspace.trial_ends_at, newTrialEndsAt },
  })

  return NextResponse.json({ ok: true, trialEndsAt: newTrialEndsAt, auditLogged })
}
