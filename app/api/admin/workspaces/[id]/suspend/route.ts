import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { cancelPaystackSubscription } from '@/lib/integrations/paystack'
import { alertBillingOps } from '@/lib/billing/ops-alert'
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
  //
  // FIX (deep audit, Billing re-pass — independent redo #4): a failure here used to end at
  // console.error, with no retry flag and no ops alert — unlike every other Paystack-cancel
  // failure in this codebase (grace enforcement, billing/cancel, workspace/delete blocks
  // outright). Worse, admin_suspend_workspace stamps deleted_at, which billing-reconcile's
  // query explicitly excludes (`.is('workspaces.deleted_at', null)`) — so a failed cancel
  // here was invisible to the one job that reconciles drift against Paystack, permanently.
  // The subscription would keep renewing and charging the card for a workspace nobody can
  // reach, with zero automated recovery path, and restore's own resumePaystackSubscription
  // call treats "already active" as success, so the whole failure silently erased itself on
  // restore too. needs_paystack_cancel + step 4b (payment-overdue) already exist to retry
  // exactly this outcome — that step's query is not joined to workspaces, so it retries
  // regardless of deleted_at, unlike billing-reconcile.
  const { data: billing } = await (service as any).from('billing').select('*').eq('workspace_id', params.id).maybeSingle()
  const cancelResult = await cancelPaystackSubscription(billing)
  if (!cancelResult.ok) {
    console.error('[admin] Paystack cancel on suspend failed:', cancelResult.error)
    if (billing?.paystack_subscription_code) {
      const { error: flagErr } = await (service as any).from('billing')
        .update({ needs_paystack_cancel: true })
        .eq('workspace_id', params.id).eq('paystack_subscription_code', billing.paystack_subscription_code)
      if (flagErr) console.error('[admin] Could not flag needs_paystack_cancel after suspend cancel failure:', flagErr.message)
      await alertBillingOps(service, `billing:orphan-sub:${params.id}`, 'Suspended workspace still has a live Paystack subscription', [
        `workspace: ${params.id}`, `subscription: ${billing.paystack_subscription_code}`, `error: ${cancelResult.error}`,
        'Will be retried on every payment-overdue run (billing.needs_paystack_cancel).',
      ])
    }
  }

  // (Billing re-pass, independent redo #3 — B3) Same reason as workspace/delete:
  // a pending checkout must not outlive the suspension and bind a fresh
  // subscription to an unreachable workspace. Best-effort.
  const { error: purgeErr } = await (service as any).from('billing_checkouts').delete()
    .eq('workspace_id', params.id).is('consumed_at', null)
  if (purgeErr) console.error('[admin] Could not purge pending checkouts on suspend:', purgeErr.message)

  // Best-effort, like the Paystack cancel above: the suspension has
  // already taken effect, so a mail failure must never surface as one.
  const agencyLabel = workspace.agency_name || workspace.name
  let notified = 0
  for (const m of (activeMembers || [])) {
    if (!m?.user?.email) continue
    try {
      // sendEmail resolves { ok: false } on a provider rejection instead of throwing.
      const res = await sendWorkspaceSuspendedEmail({
        to: m.user.email, name: m.user.name || m.user.email, agencyName: agencyLabel,
      })
      if (res && res.ok === false) console.error('[admin] Workspace suspended email rejected for', m.user.email, res.error)
      else if (!res || !res.skipped) notified++
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
