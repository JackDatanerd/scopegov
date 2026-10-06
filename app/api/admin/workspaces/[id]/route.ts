import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminRead, loadAdminHistory } from '@/lib/auth/admin'
import { fetchAll } from '@/lib/utils/fetch-all'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// FIX (Admin panel independent audit — B9): both reads were `select('*')`, which shipped every column of
// `billing` to the browser — including paystack_email_token / pending_cancel_email_token (a bearer credential for
// that customer's Paystack subscription) and the customer code — and the whole workspaces row. The old
// `delete workspace.jwt_secret` was dead code (that column no longer exists), which is exactly how a new secret
// column would have leaked. Explicit allowlists now; a column added later is not exposed until someone chooses to.
const WORKSPACE_COLS = 'id, name, agency_name, slug, plan_tier, lapsed_at, trial_ends_at, onboarding_completed_at, first_sow_signed_at, created_at, deleted_at, suspended_by_admin, currency, timezone, industry'
const BILLING_COLS = 'plan_interval, cancels_at_period_end, current_period_end, payment_method_last4, payment_method_type, grace_period_started_at, paystack_subscription_code, needs_paystack_cancel, cancelled_by_workspace_delete_at'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin()
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })

  const projectsPromise = fetchAll<{ id: string; status: string }>('admin workspace projects', (from, to) =>
    (service as any).from('projects').select('id, status').eq('workspace_id', params.id).order('id').range(from, to),
  ).then(rows => ({ rows, failed: false }), (e: unknown) => {
    console.error('[admin] workspace project counts failed:', e)
    return { rows: [] as Array<{ id: string; status: string }>, failed: true }
  })

  const [wsRes, membersRes, billingRes, activityRes, projects, history] = await Promise.all([
    (service as any).from('workspaces').select(WORKSPACE_COLS).eq('id', params.id).maybeSingle(),
    (service as any)
      .from('workspace_members')
      .select('id, status, created_at, users:user_id (id, email, name, deleted_at, suspended_by_admin), roles:role_id (name)')
      .eq('workspace_id', params.id)
      .order('created_at', { ascending: true }),
    (service as any).from('billing').select(BILLING_COLS).eq('workspace_id', params.id).maybeSingle(),
    (service as any)
      .from('audit_log')
      .select('id, event_type, entity_type, entity_name, actor_name, actor_email, created_at')
      .eq('workspace_id', params.id)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(25),
    projectsPromise,
    loadAdminHistory(service, 'workspace', params.id),
  ])

  // A failed read is a 500, not "Workspace not found" (Admin panel audit — B5); the sections that can fail on their
  // own come back as null so the page can say "could not load" instead of showing a believable empty state.
  if (wsRes.error) {
    console.error('[admin] workspace detail read failed:', wsRes.error.message)
    return NextResponse.json({ error: 'Could not load this workspace' }, { status: 500 })
  }
  const workspace = wsRes.data
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })

  for (const [label, r] of [['members', membersRes], ['billing', billingRes], ['activity', activityRes]] as const) {
    if (r.error) console.error(`[admin] workspace ${label} read failed:`, r.error.message)
  }

  let projectsByStatus: Record<string, number> | null = null
  if (!projects.failed) {
    projectsByStatus = {}
    for (const p of projects.rows) projectsByStatus[p.status] = (projectsByStatus[p.status] || 0) + 1
  }

  await logAdminRead(service, {
    actor, eventType: 'workspace.viewed', targetType: 'workspace', targetId: workspace.id,
    targetLabel: workspace.agency_name || workspace.name,
  })

  return NextResponse.json({
    workspace,
    members: membersRes.error ? null : (membersRes.data || []),
    billing: billingRes.error ? undefined : (billingRes.data || null),
    recentActivity: activityRes.error ? null : (activityRes.data || []),
    projectsByStatus,
    history,
  })
}
