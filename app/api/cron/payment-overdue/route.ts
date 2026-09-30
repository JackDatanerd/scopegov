export const runtime = 'nodejs'
// Runs six independent scans and loops over every match — same unbounded shape
// reconciliation-rollup carries this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { formatMoney } from '@/lib/utils/money'
import { NextResponse, type NextRequest } from 'next/server'
import { sendTrialWarningEmail, sendPaymentFailedEmail, sendInvoiceOverdueInternalEmail, sendPaymentMilestoneOverdueEmail, sendSubscriptionEndedEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { getBillingRecipients as getBillingRecipientsShared } from '@/lib/billing/recipients'
import { GRACE_DAYS, GRACE_REMINDER_DAYS_LEFT } from '@/lib/billing/plans'
import { cancelPaystackSubscription } from '@/lib/integrations/paystack'
import { alertBillingOps } from '@/lib/billing/ops-alert'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { insertAuditRow } from '@/lib/utils/audit'
import { CronRun, fetchAll } from '@/lib/utils/cron-run'
import { checkedSend } from '@/lib/email/delivery'

// A monthly-retainer milestone is generated on the 1st and is the agency's own billing reminder —
// the agency still has to raise the invoice. Flagging it "overdue" the next morning (and, for a
// retainer signed mid-month, immediately after signing) was a false alarm. Only flag once the
// agency has had this long to bill it.
const RETAINER_INVOICE_GRACE_DAYS = 7

// FIX (Billing fix round — MEDIUM): when a subscription ends (non-payment downgrade, period-end sweep) the
// code was cleared but the rest of the subscription's footprint was left behind: a past current_period_end
// (Billing tab: "Renews <past date>"), the old interval and card, and — after a non-payment downgrade — no
// reset of cancels_at_period_end, so the subscription.disable webhook that the downgrade itself provokes
// could flag the dead row as cancelling and step 5 would "end" it a second time. The customer code stays on
// purpose: late events for the old subscription resolve through it and are recognised as superseded.
const ENDED_SUBSCRIPTION_FIELDS = {
  paystack_subscription_code: null,
  paystack_email_token: null,
  needs_paystack_cancel: false,
  cancels_at_period_end: false,
  current_period_end: null,
  plan_interval: null,
  payment_method_last4: null,
  payment_method_type: null,
}

const WS_EMBED = 'workspaces(id,agency_name,plan_tier,deleted_at,created_by,creator:users!workspaces_created_by_fkey(name,email))'

async function getBillingRecipients(
  service: any, workspaceId: string, creator: { name?: string; email?: string } | null | undefined
): Promise<Array<{ name: string; email: string }>> {
  return getBillingRecipientsShared(service, workspaceId, [creator])
}

// Daily. Each numbered section below is an independent step: a failure in one (a bad query, a
// provider outage) is recorded and alerted, but no longer stops the sections after it — before this,
// the least important scan (milestones) ran first and its failure skipped billing enforcement for
// the whole day. Main SELECT errors are thrown (not swallowed) and every scan is paginated.
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const run = new CronRun(service, 'payment-overdue')
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const appUrl = process.env.NEXT_PUBLIC_APP_URL

  let milestonesMarkedOverdue = 0
  let invoicesMarkedOverdue = 0
  let trialsExpiredCount = 0
  let cancelledSubscriptionsEndedCount = 0

  // ── 1. Mark overdue payment milestones ──────────────────────────────────────────────────
  await run.step('1 milestones overdue', async () => {
    const retainerGraceDate = new Date(now.getTime() - RETAINER_INVOICE_GRACE_DAYS * 86400000).toISOString().split('T')[0]
    // FIX (re-audit, section 17): this scan had no `projects.deleted_at` guard while step 1b right
    // below it (invoices) already excludes a soft-deleted (trashed) project's own — "nobody can act
    // on them from the UI" (section-12 audit, pass 2). Same table shape, same reasoning; applying it
    // here for consistency and defense-in-depth. `!inner` is required for `projects.deleted_at` to
    // actually restrict the parent rows under PostgREST.
    const overdueMilestones = await fetchAll<any>('overdue milestones select', (from, to) =>
      (service as any).from('payment_milestones')
        .select(`id, title, amount, project_id, projects!inner(id, name, workspace_id, currency, deleted_at, clients(name), workspaces!inner(deleted_at))`)
        .eq('status', 'pending')
        .not('due_date', 'is', null)
        .lt('due_date', today)
        .is('projects.deleted_at', null)
        // FIX (cron section 17, pass 2): workspace delete / admin suspend sets workspaces.deleted_at and
        // deactivates memberships but never touches projects.deleted_at, so this scan kept flipping a closed
        // workspace's milestones to 'overdue' (and audit-logging it) with nobody left to notify — and a
        // restored workspace came back with them already overdue, so the real alert never fired. Same
        // `!inner` guard approval-stall / co-stall / sow-stall / retainer-milestones already carry.
        .is('projects.workspaces.deleted_at', null)
        .or(`type.is.null,type.neq.retainer_monthly,due_date.lt.${retainerGraceDate}`)
        .order('id')
        .range(from, to))

    for (const m of overdueMilestones) {
      try {
        const { data: updated, error: updErr } = await (service as any).from('payment_milestones')
          .update({ status: 'overdue' })
          .eq('id', m.id).eq('status', 'pending') // a payment/invoice may have landed since the select
          .select('id')
        if (updErr) throw new Error(updErr.message)
        if (!updated || updated.length === 0) continue // lost the race — already moved on

        const project = m.projects
        if (!project) continue

        await insertAuditRow(service, {
          workspace_id: project.workspace_id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'payment.milestone_overdue', entity_type: 'payment_milestone',
          entity_id: m.id, entity_name: m.title,
          metadata: { project_id: project.id, amount: m.amount },
        })

        await notifyMembersWithPermission(service, {
          workspaceId: project.workspace_id, permission: 'VIEW_FINANCIALS', eventType: 'payment_milestone_overdue',
          type: 'payment_milestone_overdue', title: `Milestone overdue — ${project.name}`,
          body: `"${m.title}" (${formatMoney(m.amount, project.currency)}) for ${project.clients?.name || 'the client'} is now overdue.`,
          entityType: 'project', entityId: project.id, projectId: project.id,
        })

        try {
          const emails = await getMemberEmailsWithPermission(service, project.workspace_id, 'VIEW_FINANCIALS', 10, 'payment_milestone_overdue', project.id)
          if (emails.length) {
            // FIX (re-audit, section 17): raw try/catch, not checkedSend — a Resend-level rejection
            // resolved normally instead of throwing, so this silently "succeeded." Same fix applied
            // to every send in this file; see the step-3 grace-reminder fix below for the one
            // instance where this actually mattered beyond a missed FYI (the in-app bell above is a
            // redundant channel for this particular email).
            await checkedSend(() => sendPaymentMilestoneOverdueEmail({
              to: emails,
              clientName: project.clients?.name || 'Client',
              projectName: project.name,
              milestoneTitle: m.title,
              amount: m.amount,
              currency: project.currency || 'USD',
              projectUrl: `${appUrl}/projects/${project.id}?tab=billing`,
            }), 'Milestone overdue email')
          }
        } catch (e) { console.error('Milestone overdue email failed:', e) }

        milestonesMarkedOverdue++
      } catch (e) { run.rowError(`milestone ${m.id}`, e) }
    }
  })

  // ── 1b. Mark overdue invoices ───────────────────────────────────────────────────────────
  await run.step('1b invoices overdue', async () => {
    const overdueInvoices = await fetchAll<any>('overdue invoices select', (from, to) =>
      (service as any).from('invoices')
        .select(`id, title, amount, amount_paid, currency, invoice_number, workspace_id, disputed_at, dispute_resolved_at,
          projects!inner(id, name, deleted_at, clients(name)), workspaces!inner(deleted_at)`)
        // Invoices of a soft-deleted (trashed) project are not chased or flagged
        // (section-12 audit, pass 2) — nobody can act on them from the UI.
        .is('projects.deleted_at', null)
        // FIX (cron section 17, pass 2): nor those of a deleted / admin-suspended workspace (see step 1).
        .is('workspaces.deleted_at', null)
        .in('status', ['sent', 'partially_paid'])
        .not('due_date', 'is', null)
        .lt('due_date', today)
        .order('id')
        .range(from, to))

    for (const inv of overdueInvoices) {
      try {
        const { data: updated, error: updErr } = await (service as any).from('invoices')
          .update({ status: 'overdue', updated_at: now.toISOString() })
          .eq('id', inv.id).in('status', ['sent', 'partially_paid']) // a payment may have landed since the select
          .select('id')
        if (updErr) throw new Error(updErr.message)
        if (!updated || updated.length === 0) continue
        invoicesMarkedOverdue++

        const balanceDue = Number(inv.amount) - Number(inv.amount_paid)
        const underDispute = !!inv.disputed_at && !inv.dispute_resolved_at

        await insertAuditRow(service, {
          workspace_id: inv.workspace_id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'invoice.overdue', entity_type: 'invoice',
          entity_id: inv.id, entity_name: inv.title, metadata: { balance_due: balanceDue, under_dispute: underDispute },
        })

        await notifyMembersWithPermission(service, {
          workspaceId: inv.workspace_id, permission: 'VIEW_FINANCIALS',
          eventType: 'invoice_overdue', type: 'invoice_overdue',
          title: `Invoice overdue — ${inv.projects?.name}`,
          // A disputed invoice is a conversation to have, not just a chase — say so.
          body: `${inv.projects?.clients?.name || 'Client'} has ${formatMoney(balanceDue, inv.currency)} overdue on "${inv.title}"${underDispute ? ' — the client has disputed this invoice' : ''}`,
          entityType: 'project', entityId: inv.projects?.id, projectId: inv.projects?.id,
        })

        try {
          const emails = await getMemberEmailsWithPermission(service, inv.workspace_id, 'VIEW_FINANCIALS', 10, 'invoice_overdue', inv.projects?.id)
          if (emails.length) {
            // FIX (re-audit, section 17): raw try/catch, not checkedSend — same missing-check class
            // of bug as the rest of this file.
            await checkedSend(() => sendInvoiceOverdueInternalEmail({
              to: emails,
              clientName: inv.projects?.clients?.name || 'Client',
              projectName: inv.projects?.name,
              invoiceNumber: inv.invoice_number,
              balanceDue, currency: inv.currency,
              projectUrl: `${appUrl}/projects/${inv.projects?.id}?tab=billing`,
            }), 'Invoice overdue email')
          }
        } catch (e) { console.error('Invoice overdue email failed:', e) }
      } catch (e) { run.rowError(`invoice ${inv.id}`, e) }
    }
  })

  // ── 2. Trial expiry enforcement ─────────────────────────────────────────────────────────
  // There is no grace period here: a trial past trial_ends_at is downgraded on the first run after
  // it. (An older comment claimed "3-day grace already passed"; nothing implements one, and the
  // trial-warning emails count down to zero.) Data is never deleted — only the plan changes.
  await run.step('2 trial expiry', async () => {
    const expiredTrials = await fetchAll<any>('expired trials select', (from, to) =>
      (service as any).from('workspaces')
        .select(`id, agency_name, plan_tier, trial_ends_at, created_by,
          creator:users!workspaces_created_by_fkey(name, email),
          billing(paystack_subscription_code)`)
        .eq('plan_tier', 'trial')
        .lt('trial_ends_at', now.toISOString())
        .is('deleted_at', null)
        .order('id')
        .range(from, to))

    for (const ws of expiredTrials) {
      try {
        // A trial workspace that already has a Paystack subscription is mid-conversion to a paid plan
        // (the billing webhook owns that transition) — never downgrade someone who is paying.
        if (ws.billing?.paystack_subscription_code) continue

        const { data: updatedWs, error: updErr } = await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id).eq('plan_tier', 'trial')
          .select('id')
        if (updErr) throw new Error(updErr.message)
        if (!updatedWs || updatedWs.length === 0) continue // downgraded concurrently
        trialsExpiredCount++

        await insertAuditRow(service, {
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.trial_expired', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name,
          metadata: { converted_to: 'solo' },
        })

        const recipients = await getBillingRecipients(service, ws.id, ws.creator)
        for (const r of recipients) {
          try {
            // FIX (re-audit, section 17): raw try/catch, not checkedSend — same missing-check class
            // of bug as the rest of this file. sibling trial-warning/route.ts already gets this
            // right (`const delivery = await sendTrialWarningEmail(...); if (!delivery.ok) ...`).
            const delivery = await checkedSend(() => sendTrialWarningEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              daysLeft: 0,
              upgradeUrl: `${appUrl}/settings?tab=billing`,
            }), 'Trial expiry email')
            if (!delivery.ok) console.error('Trial expiry email rejected for', r.email, delivery.error)
          } catch (e) { console.error('Trial expiry email failed for', r.email, e) }
        }
      } catch (e) { run.rowError(`trial ${ws.id}`, e) }
    }
  })

  // ── 3. Grace-period reminder (before the day-GRACE_DAYS enforcement) ────────────────────
  // FIX (cron/portal audit round 3): the reminder used to be selected with a window exactly 24h wide
  // ([now-(d+1) days, now-d days)) on the assumption that consecutive daily runs tile the timeline with
  // no gap. They don't: a run that starts a little later than yesterday's leaves a gap nobody is ever
  // selected in, and a skipped run (deploy, outage, the scheduler dropping a tick) leaves a whole
  // day-wide hole — a workspace whose grace period started in it never got the "2 days left" warning and
  // went straight to being downgraded. A missed warning on a billing downgrade is the worst place for a
  // fragile window.
  //
  // Now: everything that has reached the reminder point (started at or before now - reminderDaysIn) and
  // has not yet reached enforcement (started after now - GRACE_DAYS) is a candidate on every run, and
  // "already reminded" is decided per grace period — a reminder row logged at or after this grace
  // period's own start means it has been sent — so a late/skipped run catches up and a re-run is a no-op.
  await run.step('3 grace reminder', async () => {
    const reminderDaysIn = GRACE_DAYS - GRACE_REMINDER_DAYS_LEFT
    const reminderPoint  = new Date(now.getTime() - reminderDaysIn * 86400000).toISOString()
    const graceCutoff    = new Date(now.getTime() - GRACE_DAYS * 86400000).toISOString()
    const graceReminderDue = await fetchAll<any>('grace reminder select', (from, to) =>
      (service as any).from('billing')
        .select(`workspace_id, grace_period_started_at, ${WS_EMBED}`)
        .not('grace_period_started_at', 'is', null)
        .lte('grace_period_started_at', reminderPoint)
        .gte('grace_period_started_at', graceCutoff)
        .order('workspace_id')
        .range(from, to))

    for (const b of graceReminderDue) {
      try {
        const ws = b.workspaces
        if (!ws || ws.deleted_at) continue
        // An error here used to be ignored (`data` only), which reads as "not sent yet" and re-sent the
        // email on every run for as long as the lookup kept failing.
        const { data: alreadySent, error: sentErr } = await (service as any)
          .from('audit_log').select('id')
          .eq('workspace_id', ws.id).eq('event_type', 'billing.payment_failed_grace_reminder')
          .gte('created_at', b.grace_period_started_at)
          .limit(1).maybeSingle()
        if (sentErr) throw new Error(`reminder dedupe lookup failed: ${sentErr.message}`)
        if (alreadySent) continue

        const recipients = await getBillingRecipients(service, ws.id, ws.creator)
        // FIX (Billing fix round — minor): the email always said GRACE_REMINDER_DAYS_LEFT (3) even when a
        // catch-up run (missed/late cron tick) sent it later. Whole days actually remaining before enforcement,
        // rounded up, never below 1 (this row is only selected while its grace period has not yet expired).
        const actualDaysLeft = Math.max(1, Math.min(GRACE_REMINDER_DAYS_LEFT, Math.ceil(
          (new Date(b.grace_period_started_at).getTime() + GRACE_DAYS * 86400000 - now.getTime()) / 86400000)))
        // FIX (re-audit, section 17 — the critical finding): track actual delivery instead of
        // assuming success. The audit row below is the dedupe marker every future run checks
        // (see the lookup a few lines above) — writing it regardless of whether the send
        // actually went out meant a Resend-level rejection (rejected recipient, quota, bad
        // domain — none of which throw) silently marked this workspace "already reminded,"
        // with no successful delivery ever having happened, right before step 4/5 downgrade
        // and cancel it days later having never been warned.
        let anySent = false
        const sendErrors: string[] = []
        for (const r of recipients) {
          try {
            const delivery = await checkedSend(() => sendPaymentFailedEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              upgradeUrl: `${appUrl}/settings?tab=billing`,
              graceDaysLeft: actualDaysLeft,
            }), 'Grace reminder email')
            if (delivery.ok) anySent = true
            else sendErrors.push(`${r.email}: ${delivery.error}`)
          } catch (e) { sendErrors.push(`${r.email}: ${e instanceof Error ? e.message : String(e)}`) }
        }
        if (recipients.length > 0 && !anySent) {
          run.rowError(`grace reminder ${b.workspace_id}`, new Error(
            `reminder email failed for every recipient — dedupe marker withheld so it retries next run: ${sendErrors.join('; ')}`
          ))
          continue
        }
        const logged = await insertAuditRow(service, {
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.payment_failed_grace_reminder', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name,
          metadata: { grace_days_left: GRACE_REMINDER_DAYS_LEFT, grace_period_started_at: b.grace_period_started_at },
        })
        // audit_log is append-only, so the "sent" marker cannot be rolled back — if it failed to write the
        // reminder will go out again tomorrow. Say so loudly rather than duplicate silently.
        if (logged === false) run.rowError(`grace reminder ${b.workspace_id}`, new Error('reminder sent but its dedupe audit row failed to write — will be re-sent next run'))
      } catch (e) { run.rowError(`grace reminder ${b.workspace_id}`, e) }
    }
  })

  // ── 4. Grace-period enforcement ─────────────────────────────────────────────────────────
  await run.step('4 grace enforcement', async () => {
    const graceCutoff = new Date(now.getTime() - GRACE_DAYS * 86400000).toISOString()
    const graceExpired = await fetchAll<any>('grace enforcement select', (from, to) =>
      (service as any).from('billing')
        .select(`workspace_id, grace_period_started_at, paystack_subscription_code, paystack_email_token, ${WS_EMBED}`)
        .not('grace_period_started_at', 'is', null)
        .lt('grace_period_started_at', graceCutoff)
        .order('workspace_id')
        .range(from, to))

    for (const b of graceExpired) {
      try {
        const ws = b.workspaces
        if (!ws || ws.deleted_at) continue

        // Claim the row first (clears the grace clock) so a concurrent run/webhook can't double-process.
        const { data: guardedBilling, error: claimErr } = await (service as any).from('billing')
          .update({ grace_period_started_at: null })
          .eq('workspace_id', b.workspace_id)
          .not('grace_period_started_at', 'is', null)
          .lt('grace_period_started_at', graceCutoff)
          .select('workspace_id')
        if (claimErr) throw new Error(claimErr.message)
        if (!guardedBilling?.length) continue // cleared concurrently

        // FIX (deep audit, Billing re-pass — independent redo #4): every write below that
        // assumes b.paystack_subscription_code is still the workspace's live subscription
        // used to be conditioned on workspace_id alone — unlike the functionally identical
        // situation in the webhook's subscription.disable handler and billing-reconcile's
        // repair write, both of which guard with `.eq('paystack_subscription_code', ...)`
        // for exactly this reason. The claim above only protects grace_period_started_at; it
        // does nothing to stop a plan switch (subscription.create — reachable right now via
        // the grace banner's own "Retry with a new card" button, which starts a brand-new
        // subscription on this same workspace) from landing while this row's Paystack call is
        // in flight. Unguarded, the writes below would either silently wipe a customer's
        // brand-new, already-paid subscription out of the billing row (ENDED_SUBSCRIPTION_
        // FIELDS clobbering paystack_subscription_code/current_period_end/card back to null),
        // or — worse — flag that brand-new subscription needs_paystack_cancel: true, which
        // step 4b would then actually go and cancel on a later run. Every write here now
        // carries the same subscription-code guard, and a guard that matches zero rows means
        // a newer subscription is already on file: nothing to do, and the workspace is left
        // on whatever plan that subscription's own handler set (the downgrade below is skipped).
        let paystackCancelled = true
        let raced = false
        if (!b.paystack_subscription_code) {
          const { data: cleared, error: clearErr } = await (service as any).from('billing')
            .update({ ...ENDED_SUBSCRIPTION_FIELDS, updated_at: now.toISOString() })
            .eq('workspace_id', b.workspace_id).is('paystack_subscription_code', null)
            .select('workspace_id')
          if (clearErr) throw new Error(clearErr.message)
          raced = !cleared?.length
        }
        if (b.paystack_subscription_code) {
          const r = await cancelPaystackSubscription({
            paystack_subscription_code: b.paystack_subscription_code, paystack_email_token: b.paystack_email_token,
          })
          paystackCancelled = r.ok
          if (r.ok) {
            const { data: cleared, error: clearErr } = await (service as any).from('billing')
              .update({ ...ENDED_SUBSCRIPTION_FIELDS, updated_at: now.toISOString() })
              .eq('workspace_id', b.workspace_id).eq('paystack_subscription_code', b.paystack_subscription_code)
              .select('workspace_id')
            if (clearErr) throw new Error(clearErr.message)
            raced = !cleared?.length
          } else {
            // Leave the code in place and flag it so step 4b retries — the customer must not keep being charged.
            const { data: flagged, error: flagErr } = await (service as any).from('billing')
              .update({ needs_paystack_cancel: true })
              .eq('workspace_id', b.workspace_id).eq('paystack_subscription_code', b.paystack_subscription_code)
              .select('workspace_id')
            if (flagErr) throw new Error(flagErr.message)
            raced = !flagged?.length
            if (!raced) {
              await alertBillingOps(service, `billing:orphan-sub:${b.workspace_id}`, 'Downgraded workspace still has a live Paystack subscription', [
                `workspace: ${b.workspace_id}`, `subscription: ${b.paystack_subscription_code}`, `error: ${r.error}`,
                'Will be retried on every payment-overdue run (billing.needs_paystack_cancel).',
              ])
            }
            // If raced, a plan switch already replaced this subscription on the billing row —
            // its own subscription.create handler already tried (and, on its own failure,
            // recorded a billing_pending_subscription_cancels retry for) this exact old
            // subscription code, so there is nothing left for this failure branch to do.
          }
        }

        if (raced) {
          // A newer subscription is already on file: its own handler owns the workspace's plan. The
          // downgrade has not been applied yet (it now runs LAST, below), so there is nothing to revert —
          // the old revert wrote back the stale plan_tier read at select time and could clobber the tier
          // the plan switch had just set.
          console.log(`Grace enforcement: workspace ${ws.id} got a new subscription while this row was being processed — leaving its plan untouched`)
          continue
        }

        // FIX (cron section 17, pass 2): the downgrade is the LAST write and compare-and-set on the plan the
        // row was read with. It used to run first and be reverted to that stale value when a plan switch
        // was detected, which overwrote the new plan the webhook had written in between.
        const { data: downgraded, error: downgradeErr } = await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id).eq('plan_tier', ws.plan_tier)
          .select('id')
        if (downgradeErr) {
          // The subscription side is already settled, so put the grace clock back (only if nothing has
          // started a fresh one) and tomorrow's run retries instead of the workspace keeping paid
          // features forever with nothing left to trigger the downgrade.
          console.error('Grace enforcement: downgrade failed, restoring grace clock:', downgradeErr.message)
          await (service as any).from('billing')
            .update({ grace_period_started_at: b.grace_period_started_at })
            .eq('workspace_id', b.workspace_id).is('grace_period_started_at', null)
          throw new Error(`downgrade failed for ${ws.id}: ${downgradeErr.message}`)
        }
        if (!downgraded?.length) {
          console.log(`Grace enforcement: workspace ${ws.id} changed plan while this row was being processed — not downgrading`)
          continue
        }

        await insertAuditRow(service, {
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.downgraded_for_nonpayment', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name, metadata: { paystack_subscription_disabled: paystackCancelled },
        })

        const recipients = await getBillingRecipients(service, ws.id, ws.creator)
        for (const r of recipients) {
          try {
            // FIX (re-audit, section 17): raw try/catch, not checkedSend — same missing-check
            // class of bug as the rest of this file. No dedupe-marker risk here (the downgrade
            // itself, and its audit row above, already happened regardless of this email), but
            // a rejected send was still silently treated as delivered.
            const delivery = await checkedSend(() => sendSubscriptionEndedEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              upgradeUrl: `${appUrl}/settings?tab=billing`,
            }), 'Grace enforcement email')
            if (!delivery.ok) console.error('Grace enforcement email rejected for', r.email, delivery.error)
          } catch (e) { console.error('Grace enforcement email failed for', r.email, e) }
        }
      } catch (e) { run.rowError(`grace enforcement ${b.workspace_id}`, e) }
    }
  })

  // ── 4b. Retry Paystack cancellations that failed during a downgrade ──────────────────────
  await run.step('4b paystack cancel retry', async () => {
    const pendingCancels = await fetchAll<any>('pending paystack cancels select', (from, to) =>
      (service as any).from('billing')
        .select('workspace_id, paystack_subscription_code, paystack_email_token')
        .eq('needs_paystack_cancel', true)
        .not('paystack_subscription_code', 'is', null)
        .order('workspace_id')
        .range(from, to))

    for (const b of pendingCancels) {
      try {
        const r = await cancelPaystackSubscription({
          paystack_subscription_code: b.paystack_subscription_code, paystack_email_token: b.paystack_email_token,
        })
        if (r.ok) {
          // FIX (deep audit, Billing re-pass — independent redo #4): same guard as step 4
          // above and for the same reason — between the Paystack call and this write, a plan
          // switch can replace b.paystack_subscription_code with a brand-new, already-paid
          // subscription. Unguarded, this would wipe that new subscription's billing row.
          // A guard that matches zero rows means exactly that happened; nothing to clear.
          const { data: cleared, error: clearErr } = await (service as any).from('billing')
            .update({ ...ENDED_SUBSCRIPTION_FIELDS, updated_at: now.toISOString() })
            .eq('workspace_id', b.workspace_id).eq('paystack_subscription_code', b.paystack_subscription_code)
            .select('workspace_id')
          if (clearErr) throw new Error(clearErr.message)
          if (!cleared?.length) console.log(`Paystack cancel retry: workspace ${b.workspace_id} got a new subscription before the ended-fields write landed — skipping`)
        } else {
          await alertBillingOps(service, `billing:orphan-sub:${b.workspace_id}`, 'Downgraded workspace still has a live Paystack subscription', [
            `workspace: ${b.workspace_id}`, `subscription: ${b.paystack_subscription_code}`, `error: ${r.error}`,
          ], 24 * 3600_000)
        }
      } catch (e) { run.rowError(`paystack retry ${b.workspace_id}`, e) }
    }
  })

  // ── 4c. Retry Paystack cancellations that failed after a plan switch ─────────────────────
  // Independent of 4b: this retries specific OLD subscriptions recorded in
  // billing_pending_subscription_cancels (094) when subscription.create couldn't disable them,
  // without touching billing.paystack_subscription_code, which by then already holds the
  // workspace's current, paying subscription.
  //
  // FIX (deep audit, Billing re-pass — independent redo #2): this used to read/clear a single
  // pending_cancel_subscription_code slot on the `billing` row (081) — one workspace could only
  // ever have ONE such retry remembered at a time, so a second plan switch's outcome (even a
  // successful one, for a different old subscription) could silently erase the retry record for
  // an earlier, still-undisabled subscription before this step ever saw it. One row per
  // still-unresolved old subscription (rather than per workspace) means an arbitrary number of
  // them are tracked and retried independently; a row is deleted only once ITS specific
  // subscription is confirmed disabled.
  await run.step('4c paystack plan-switch cancel retry', async () => {
    const pendingSwitchCancels = await fetchAll<any>('pending plan-switch cancels select', (from, to) =>
      (service as any).from('billing_pending_subscription_cancels')
        .select('id, workspace_id, subscription_code, email_token')
        // Unlike the single-row-per-workspace `billing` table this replaces,
        // a workspace can now have more than one row here — a deterministic
        // secondary order keeps offset paging from skipping/duplicating a
        // row across pages the same way every other multi-row scan in this
        // codebase already orders by id after its primary column.
        .order('workspace_id').order('id')
        .range(from, to))

    for (const b of pendingSwitchCancels) {
      try {
        const r = await cancelPaystackSubscription({
          paystack_subscription_code: b.subscription_code, paystack_email_token: b.email_token,
        })
        if (r.ok) {
          await (service as any).from('billing_pending_subscription_cancels').delete().eq('id', b.id)
        } else {
          await (service as any).from('billing_pending_subscription_cancels')
            .update({ last_attempt_at: now.toISOString(), last_error: r.error ?? null }).eq('id', b.id)
          await alertBillingOps(service, `billing:double-billing:${b.workspace_id}:${b.subscription_code}`, 'Previous subscription still not disabled after a plan switch', [
            `workspace: ${b.workspace_id}`, `old subscription: ${b.subscription_code}`, `error: ${r.error}`,
          ], 24 * 3600_000)
        }
      } catch (e) { run.rowError(`plan-switch cancel retry ${b.workspace_id}`, e) }
    }
  })

  // ── 5. Cancelled subscriptions past their paid period end ────────────────────────────────
  await run.step('5 cancelled subscriptions', async () => {
    const cancelledExpired = await fetchAll<any>('cancelled subscriptions select', (from, to) =>
      (service as any).from('billing')
        .select(`workspace_id, current_period_end, paystack_subscription_code, paystack_customer_code,
          paystack_email_token, plan_interval, payment_method_last4, payment_method_type, ${WS_EMBED}`)
        .eq('cancels_at_period_end', true)
        .not('current_period_end', 'is', null)
        .lt('current_period_end', now.toISOString())
        .order('workspace_id')
        .range(from, to))

    for (const b of cancelledExpired) {
      try {
        const ws = b.workspaces
        if (!ws || ws.deleted_at) continue

        // Claim first (only one run/webhook proceeds; also guards a reactivation landing in between)...
        // FIX (cron section 17, pass 2): the claim is now also pinned to the subscription code that was read,
        // so a plan switch that replaced it between the select and this write can't have its brand-new
        // subscription's fields wiped by ENDED_SUBSCRIPTION_FIELDS.
        let claimQ = (service as any).from('billing')
          .update({ ...ENDED_SUBSCRIPTION_FIELDS, paystack_customer_code: null, updated_at: now.toISOString() })
          .eq('workspace_id', b.workspace_id)
          .eq('cancels_at_period_end', true)
          .lt('current_period_end', now.toISOString())
        claimQ = b.paystack_subscription_code
          ? claimQ.eq('paystack_subscription_code', b.paystack_subscription_code)
          : claimQ.is('paystack_subscription_code', null)
        const { data: guardedBilling, error: claimErr } = await claimQ.select('workspace_id')
        if (claimErr) throw new Error(claimErr.message)
        if (!guardedBilling?.length) continue // reactivated / plan-switched concurrently
        cancelledSubscriptionsEndedCount++

        // ...then downgrade, compare-and-set on the plan the row was read with: a subscription.create that
        // lands between the claim and this write has already set the new plan, and an unconditional write
        // here would have flattened it to 'solo'. This write's error used to be ignored: if it failed, the
        // claim above had already wiped cancels_at_period_end, so nothing would ever select this workspace
        // again and it kept its paid plan for free indefinitely. (Section 4 had the same fix.)
        const { data: downgraded, error: downgradeErr } = await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id).eq('plan_tier', ws.plan_tier)
          .select('id')
        if (downgradeErr) {
          await (service as any).from('billing').update({
            cancels_at_period_end: true,
            paystack_subscription_code: b.paystack_subscription_code ?? null,
            paystack_customer_code: b.paystack_customer_code ?? null,
            paystack_email_token: b.paystack_email_token ?? null,
            current_period_end: b.current_period_end ?? null,
            plan_interval: b.plan_interval ?? null,
            payment_method_last4: b.payment_method_last4 ?? null,
            payment_method_type: b.payment_method_type ?? null,
          }).eq('workspace_id', b.workspace_id).is('paystack_subscription_code', null)
          cancelledSubscriptionsEndedCount--
          throw new Error(`downgrade failed for ${ws.id}: ${downgradeErr.message}`)
        }
        if (!downgraded?.length) {
          cancelledSubscriptionsEndedCount--
          console.log(`Cancelled-subscription sweep: workspace ${ws.id} changed plan while this row was being processed — not downgrading`)
          continue
        }

        await insertAuditRow(service, {
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.subscription_ended', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name,
          metadata: { converted_to: 'solo', period_end: b.current_period_end },
        })

        const recipients = await getBillingRecipients(service, ws.id, ws.creator)
        for (const r of recipients) {
          try {
            // FIX (re-audit, section 17): raw try/catch, not checkedSend — same missing-check
            // class of bug as the rest of this file. No dedupe-marker risk here (the cancellation
            // itself, and its audit row above, already happened regardless of this email).
            const delivery = await checkedSend(() => sendSubscriptionEndedEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              upgradeUrl: `${appUrl}/settings?tab=billing`,
            }), 'Cancelled-subscription email')
            if (!delivery.ok) console.error('Cancelled-subscription email rejected for', r.email, delivery.error)
          } catch (e) { console.error('Cancelled-subscription email failed for', r.email, e) }
        }
      } catch (e) { run.rowError(`cancelled subscription ${b.workspace_id}`, e) }
    }
  })

  // ── 6. Housekeeping (best-effort) ────────────────────────────────────────────────────────
  await run.step('6 housekeeping', async () => {
    const { error: pruneEventsErr } = await (service as any).from('processed_webhook_events').delete()
      .eq('status', 'done').lt('processed_at', new Date(now.getTime() - 90 * 86400000).toISOString())
    if (pruneEventsErr) console.error('Prune processed_webhook_events failed:', pruneEventsErr.message)
    const { error: pruneCheckoutsErr } = await (service as any).from('billing_checkouts').delete()
      .lt('created_at', new Date(now.getTime() - 7 * 86400000).toISOString())
    if (pruneCheckoutsErr) console.error('Prune billing_checkouts failed:', pruneCheckoutsErr.message)
  })

  Object.assign(run.result, {
    milestonesMarkedOverdue,
    invoicesOverdue: invoicesMarkedOverdue,
    trialsExpired: trialsExpiredCount,
    cancelledSubscriptionsEnded: cancelledSubscriptionsEndedCount,
  })
  const { body, status } = await run.finish()
  return NextResponse.json(body, { status })
}

// Vercel Cron invokes the configured path with GET; the GitHub Actions backup uses POST.
export const GET = POST
