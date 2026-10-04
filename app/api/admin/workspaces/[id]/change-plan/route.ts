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

  const { data: workspace, error: wsErr } = await (service as any)
    .from('workspaces').select('id, name, agency_name, plan_tier, deleted_at').eq('id', params.id).maybeSingle()
  if (wsErr) {
    console.error('[admin] change plan: workspace read failed:', wsErr.message)
    return NextResponse.json({ error: 'Could not load this workspace' }, { status: 500 })
  }
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  // FIX (Admin panel independent audit — B10): both plan routes ran on a suspended or deleted workspace, silently
  // writing entitlement for a tenant nobody can reach (and a restore would then come back on a plan nobody chose).
  if (workspace.deleted_at) {
    return NextResponse.json({ error: 'This workspace is suspended or deleted — restore it before changing its plan.' }, { status: 409 })
  }
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
  // Pinned to the plan that was read: the Paystack webhook / payment-overdue cron can change plan_tier between the
  // read and this write, and an unpinned update would overwrite their change without a trace.
  const { data: changed, error } = await (service as any)
    .from('workspaces')
    .update({
      plan_tier: plan,
      // Off the trial plan the end date is meaningless (the webhook nulls it the same way on a paid upgrade).
      trial_ends_at: plan === 'trial' ? new Date(Date.now() + trialDays * 86400_000).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id).eq('plan_tier', workspace.plan_tier).is('deleted_at', null)
    .select('id')

  if (error) {
    console.error('[admin] change plan failed:', error.message)
    return NextResponse.json({ error: 'Could not change plan' }, { status: 500 })
  }
  if (!changed || changed.length === 0) {
    return NextResponse.json({ error: 'The workspace changed while you were editing (plan or suspension). Reload and try again.' }, { status: 409 })
  }

  // FIX (Admin panel independent audit — B10): an open payment-failure grace window survived a manual plan change, so
  // payment-overdue still enforced it when it expired and flipped the comped plan straight back to Solo — the same
  // "silently undone" failure the trial branch above already fixed for trial_ends_at. A manual override ends it.
  const { data: graceRows, error: graceErr } = await (service as any).from('billing')
    .update({ grace_period_started_at: null, updated_at: new Date().toISOString() })
    .eq('workspace_id', params.id).not('grace_period_started_at', 'is', null)
    .select('workspace_id')
  if (graceErr) console.error('[admin] change plan: could not clear grace period (non-fatal):', graceErr.message)
  const graceCleared = !graceErr && (graceRows?.length ?? 0) > 0

  const auditLogged = await logAdminAction(service, {
    actor,
    eventType: 'workspace.plan_changed',
    targetType: 'workspace',
    targetId: workspace.id,
    targetLabel: workspace.agency_name || workspace.name,
    metadata: { previousPlan: workspace.plan_tier, newPlan: plan, reason: reason || null, ...(plan === 'trial' ? { trialDays } : {}), ...(graceCleared ? { graceCleared: true } : {}), ...(graceErr ? { graceClearFailed: true } : {}) },
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
    omitClientIp: true, // staff IP must not appear in the customer's audit log / exports
  })

  return NextResponse.json({ ok: true, plan, graceCleared, auditLogged })
}
