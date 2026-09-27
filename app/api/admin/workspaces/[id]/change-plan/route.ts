import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'

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

  const body = await request.json().catch(() => ({})) as { plan?: unknown; reason?: unknown }
  const plan = body.plan
  if (typeof plan !== 'string' || !VALID_PLANS.includes(plan as ValidPlan)) {
    return NextResponse.json({ error: `plan must be one of: ${VALID_PLANS.join(', ')}` }, { status: 400 })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''

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
    .update({ plan_tier: plan, updated_at: new Date().toISOString() })
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
    metadata: { previousPlan: workspace.plan_tier, newPlan: plan, reason: reason || null },
  })

  return NextResponse.json({ ok: true, plan })
}
