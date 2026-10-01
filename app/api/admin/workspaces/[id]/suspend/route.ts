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
  // workspace_members has two FKs to users — the embed must name the constraint or PostgREST
  // rejects it as ambiguous (and, with the error ignored, nobody was ever notified).
  const { data: activeMembers, error: membersReadErr } = await (service as any)
    .from('workspace_members')
    .select('user_id, user:users!workspace_members_user_id_fkey(email, name)')
    .eq('workspace_id', params.id).eq('status', 'active')
  if (membersReadErr) console.error('[admin] suspend: could not read members to notify (non-fatal):', membersReadErr.message)

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

  // FIX (cron section 17, round 6 — B1): remember that THIS suspension is what disabled the Paystack subscription, so
  // admin restore re-enables it only in that case (same marker, same reasoning as workspace/delete, migration 132 —
  // a workspace is either self-deleted or suspended at one time, so the column is not ambiguous). Without it admin
  // restore resumed any subscription, undoing a cancellation the owner had requested themselves before the suspension.
  // Not set when the subscription was already non-renewing (nothing for restore to undo) or when the cancel FAILED
  // (that case is carried by needs_paystack_cancel, which restore also reads). Retried once; if it still cannot be
  // written, ops is told that restore will not auto-resume.
  const cancelledBySuspend = !!billing?.paystack_subscription_code && cancelResult.ok && !cancelResult.alreadyCancelled
  if (cancelledBySuspend) {
    const mark = () => (service as any).from('billing')
      .update({ cancelled_by_workspace_delete_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('workspace_id', params.id)
    let marked = await mark()
    if (marked.error) marked = await mark()
    if (marked.error) {
      await alertBillingOps(service, `billing:suspend-marker:${params.id}`, 'Workspace suspended but suspend-cancel marker not recorded', [
        `workspace: ${params.id}`,
        `Paystack subscription was cancelled by the suspension but billing.cancelled_by_workspace_delete_at could not be written: ${marked.error.message}`,
        'If this workspace is restored its subscription will NOT be re-enabled automatically — resume it by hand.',
      ]).catch(() => {})
    }
  } else if (cancelResult.ok && billing?.cancelled_by_workspace_delete_at) {
    // A marker left over from an earlier delete/restore cycle must not survive a suspension that did NOT cancel
    // anything, or a later restore would resume a subscription the owner cancelled themselves.
    const { error: clrErr } = await (service as any).from('billing')
      .update({ cancelled_by_workspace_delete_at: null }).eq('workspace_id', params.id)
    if (clrErr) console.error('[admin] suspend: could not clear stale cancel marker (non-fatal):', clrErr.message)
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
