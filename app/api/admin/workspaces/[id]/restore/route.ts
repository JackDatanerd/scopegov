import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { resumePaystackSubscription } from '@/lib/integrations/paystack'
import { alertBillingOps } from '@/lib/billing/ops-alert'
import { sendWorkspaceRestoredEmail } from '@/lib/email/templates'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { data: workspace, error: wsErr } = await (service as any)
    .from('workspaces').select('id, name, agency_name, deleted_at, suspended_by_admin').eq('id', params.id).maybeSingle()
  if (wsErr) {
    console.error('[admin] restore workspace: read failed:', wsErr.message)
    return NextResponse.json({ error: 'Could not load this workspace' }, { status: 500 })
  }
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  if (!workspace.deleted_at) return NextResponse.json({ error: 'Not suspended' }, { status: 409 })

  // FIX (Admin panel independent audit — G4): deleted_at is shared with the owner's own "delete workspace". Restore
  // used to undo that on a plain click. Only an admin suspension restores unprompted; a self-deleted workspace needs
  // an explicit confirmation (which also re-enables a subscription the delete cancelled — the confirm text says so).
  const body = await request.json().catch(() => ({})) as { confirmSelfDeleted?: unknown }
  const restoredSelfDeleted = !workspace.suspended_by_admin
  if (restoredSelfDeleted && body.confirmSelfDeleted !== true) {
    return NextResponse.json({
      error: 'This workspace was deleted by its owner, not suspended from the panel. Restoring it reactivates its members and re-enables any subscription the deletion cancelled. Confirm to restore anyway.',
      code: 'self_deleted',
    }, { status: 409 })
  }

  const { error } = await (service as any).rpc('admin_restore_workspace', { p_workspace_id: params.id })
  if (error) {
    // B11: the RPC raises when a concurrent restore already won — a conflict, and it must stop before the Paystack
    // resume / member e-mails below run twice.
    if (/not_suspended|not_found/.test(error.message || '')) {
      return NextResponse.json({ error: 'Not suspended' }, { status: 409 })
    }
    console.error('[admin] restore workspace failed:', error.message)
    return NextResponse.json({ error: 'Could not restore workspace' }, { status: 500 })
  }

  // FIX (cron section 17, round 6 — B1, HIGH): this used to call resumePaystackSubscription and stop. Two pieces of
  // billing state written while the workspace was suspended outlived the restore, and cron/payment-overdue acts on both:
  //   * `cancels_at_period_end` — the suspension's own Paystack disable fires subscription.disable, which flags the row
  //     as cancelling (the webhook does not look at workspaces.deleted_at). Left set on a restored, still-paying
  //     workspace, step 5 downgrades it to Solo and wipes its live subscription fields the first time
  //     current_period_end is in the past — and a suspension routinely spans a period end. The self-service restore
  //     already clears it (workspace/restore, with its own comment); this admin path never did.
  //   * `needs_paystack_cancel` — set when the cancel at suspend FAILED, so step 4b would retry it. 4b is not joined to
  //     workspaces, so after the restore it went on to cancel the subscription the admin had just re-enabled and clear
  //     the subscription fields WITHOUT downgrading the plan: a live workspace on a paid tier with nothing renewing it.
  // The flag is obsolete the moment the workspace is live again, whatever the resume does, so it is cleared first (before
  // any Paystack call, shrinking the window in which 4b could still pick the row up). Both writes are pinned to the
  // subscription code that was read, so a plan switch landing in between is never touched.
  const { data: billing } = await (service as any).from('billing').select('*').eq('workspace_id', params.id).maybeSingle()
  const subCode: string | null = billing?.paystack_subscription_code ?? null

  if (subCode && billing.needs_paystack_cancel) {
    const { error: flagErr } = await (service as any).from('billing')
      .update({ needs_paystack_cancel: false, updated_at: new Date().toISOString() })
      .eq('workspace_id', params.id).eq('paystack_subscription_code', subCode)
    if (flagErr) {
      await alertBillingOps(service, `billing:restore-cancel-flag:${params.id}`, 'Workspace restored but needs_paystack_cancel could not be cleared', [
        `workspace: ${params.id}`, `subscription: ${subCode}`, `error: ${flagErr.message}`,
        'payment-overdue step 4b will cancel this live subscription on its next run. Clear billing.needs_paystack_cancel by hand NOW.',
      ]).catch(() => {})
    }
  }

  // Re-enable only what the SUSPENSION cancelled (billing.cancelled_by_workspace_delete_at, set by admin suspend) or what
  // may have been cancelled without us hearing about it (needs_paystack_cancel: the cancel call failed or its response was
  // lost — resume treats "already active" as success). A subscription the owner had cancelled themselves before the
  // suspension is left cancelled, exactly as workspace/restore does for a self-service delete.
  const shouldResume = !!subCode && (!!billing.cancelled_by_workspace_delete_at || !!billing.needs_paystack_cancel)
  let resumeResult: { ok: boolean; error?: string; skipped?: boolean } = { ok: true, skipped: true }
  if (shouldResume) {
    resumeResult = await resumePaystackSubscription(billing)
    if (!resumeResult.ok) {
      console.error('[admin] Paystack resume on restore failed:', resumeResult.error)
      await alertBillingOps(service, `billing:restore-resume:${params.id}`, 'Workspace restored but its subscription could not be re-enabled', [
        `workspace: ${params.id}`, `subscription: ${subCode}`, `resume error: ${resumeResult.error || 'unknown'}`,
        'The workspace is live again but its Paystack subscription is still cancelled by the suspension. Resume it manually. Until then billing.cancels_at_period_end stays set, so the period-end sweep will downgrade it.',
      ]).catch(() => {})
    } else {
      const localUpdate = () => (service as any).from('billing').update({
        cancels_at_period_end: false, cancelled_by_workspace_delete_at: null, updated_at: new Date().toISOString(),
      }).eq('workspace_id', params.id).eq('paystack_subscription_code', subCode)
      let upd = await localUpdate()
      if (upd.error) upd = await localUpdate()
      if (upd.error) {
        await alertBillingOps(service, `billing:restore-resume-local-write:${params.id}`, 'Resume-on-restore not recorded locally', [
          `workspace: ${params.id}`,
          `Paystack subscription was RE-ENABLED on admin restore but billing.cancels_at_period_end could not be cleared: ${upd.error.message}`,
          'Left as-is, the period-end sweep would downgrade a customer who is still being charged.',
        ]).catch(() => {})
      }
    }
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
    const { data: reactivated, error: reactivatedErr } = await (service as any)
      .from('workspace_members')
      .select('user_id, user:users!workspace_members_user_id_fkey(email, name)')
      .eq('workspace_id', params.id).eq('status', 'active')
    if (reactivatedErr) console.error('[admin] restore: could not read members to notify (non-fatal):', reactivatedErr.message)
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

  const auditLogged = await logAdminAction(service, {
    actor,
    eventType: 'workspace.restored',
    targetType: 'workspace',
    targetId: workspace.id,
    targetLabel: workspace.agency_name || workspace.name,
    metadata: { paystackResumeOk: resumeResult.ok, ...(resumeResult.skipped ? { paystackResumeSkipped: true } : {}), ...(restoredSelfDeleted ? { restoredSelfDeleted: true } : {}), membersNotified: notified },
  })

  return NextResponse.json({ ok: true, paystackResumeOk: resumeResult.ok, membersNotified: notified, auditLogged })
}
