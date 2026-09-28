import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { logAudit } from '@/lib/utils/audit'

// Matches lib/supabase/types.ts's Plan union / the plan_tier enum
// (001_initial_schema.sql). Kept as a local literal list rather than
// importing the type, since this is a runtime validation boundary, not a
// compile-time one.
const VALID_PLANS = ['trial', 'solo', 'starter', 'pro', 'agency'] as const
type ValidPlan = typeof VALID_PLANS[number]

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const body = await request.json().catch(() => ({})) as { plan?: unknown; reason?: unknown; trialDays?: unknown }
  const plan = body.plan
  if (typeof plan !== 'string' || !VALID_PLANS.includes(plan as ValidPlan)) {
    return NextResponse.json({ error: `plan must be one of: ${VALID_PLANS.join(', ')}` }, { status: 400 })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  // FIX (Billing fix round — MEDIUM): moving a workspace TO 'trial' never set trial_ends_at. A null date meant
  // the trial never expired and never warned; a stale past date meant the next payment-overdue run flipped it
  // straight back to Solo, silently undoing the admin's change. A trial now always gets a fresh end date
  // (default 14 days, or `trialDays` 1-365).
  let trialDays = 14
  if (body.trialDays !== undefined) {
    const n = Number(body.trialDays)
    if (!Number.isInteger(n) || n < 1 || n > 365)
      return NextResponse.json({ error: 'trialDays must be a whole number between 1 and 365' }, { status: 400 })
    trialDays = n
  }

  const { data: workspace } = await (service as any)
    .from('workspaces').select('id, name, agency_name, plan_tier').eq('id', params.id).maybeSingle()
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  if (workspace.plan_tier === plan) {
    return NextResponse.json({ error: `Already on ${plan}` }, { status: 409 })
  }

  // This changes the app's own entitlement flag only — it does NOT touch
  // Paystack. Moving someone off a paid plan this way leaves whatever
  // subscription they have running in Paystack untouched (same as every
  // other manual override this route is for: comping a plan, correcting a
  // stuck webhook, or unblocking someone while a real billing question gets
  // sorted out by hand) — the admin is expected to reconcile Paystack
  // separately via the Billing tab when that's the actual intent.
  const { error } = await (service as any)
    .from('workspaces')
    .update({
      plan_tier: plan,
      // Off the trial plan the end date is meaningless (the webhook nulls it the same way on a paid upgrade).
      trial_ends_at: plan === 'trial' ? new Date(Date.now() + trialDays * 86400_000).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)

  if (error) {
    console.error('[admin] change plan failed:', error.message)
    return NextResponse.json({ error: 'Could not change plan' }, { status: 500 })
  }

  await logAdminAction(service, {
    actor,
    eventType: 'workspace.plan_changed',
    targetType: 'workspace',
    targetId: workspace.id,
    targetLabel: workspace.agency_name || workspace.name,
    metadata: { previousPlan: workspace.plan_tier, newPlan: plan, reason: reason || null, ...(plan === 'trial' ? { trialDays } : {}) },
  })

  // FIX (deep audit, Reports & Audit / Billing re-pass — independent redo):
  // this only ever wrote to platform_admin_audit_log — a table the affected
  // workspace has no access to at all. Its own Settings -> Audit log
  // (VIEW_AUDIT_LOG) and its own Billing -> Payment history
  // (api/billing/history, which reads billing.plan_changed rows from this
  // same audit_log) both showed nothing, so a workspace's plan could be
  // changed by platform staff with zero record visible to the workspace
  // itself. Written as the same 'billing.plan_changed' event type every
  // other plan change already uses (cancel/upgrade/webhook), with a
  // distinct `action` so the Billing tab labels it for what it is rather
  // than implying the customer did it themselves.
  await logAudit(service, {
    workspaceId: workspace.id, actorId: null,
    actorEmail: 'admin@scopegov.app', actorName: 'ScopeGov staff',
    eventType: 'billing.plan_changed', entityType: 'workspace',
    entityId: workspace.id, entityName: workspace.agency_name || workspace.name,
    metadata: {
      action: 'admin_override',
      from: workspace.plan_tier, to: plan,
      reason: reason || undefined,
      ...(plan === 'trial' ? { trial_days: trialDays } : {}),
    },
  })

  return NextResponse.json({ ok: true, plan })
}
