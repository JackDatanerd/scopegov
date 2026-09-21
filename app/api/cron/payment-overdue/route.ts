export const runtime = 'nodejs'
// Runs six independent scans and loops over every match — same unbounded shape
// reconciliation-rollup carries this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
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

// A monthly-retainer milestone is generated on the 1st and is the agency's own billing reminder —
// the agency still has to raise the invoice. Flagging it "overdue" the next morning (and, for a
// retainer signed mid-month, immediately after signing) was a false alarm. Only flag once the
// agency has had this long to bill it.
const RETAINER_INVOICE_GRACE_DAYS = 7

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
    const overdueMilestones = await fetchAll<any>('overdue milestones select', (from, to) =>
      (service as any).from('payment_milestones')
        .select(`id, title, amount, project_id, projects(id, name, workspace_id, currency, clients(name))`)
        .eq('status', 'pending')
        .not('due_date', 'is', null)
        .lt('due_date', today)
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
          body: `"${m.title}" (${project.currency || 'USD'} ${Number(m.amount).toLocaleString()}) for ${project.clients?.name || 'the client'} is now overdue.`,
          entityType: 'project', entityId: project.id, projectId: project.id,
        })

        try {
          const emails = await getMemberEmailsWithPermission(service, project.workspace_id, 'VIEW_FINANCIALS', 10, 'payment_milestone_overdue', project.id)
          if (emails.length) {
            await sendPaymentMilestoneOverdueEmail({
              to: emails,
              clientName: project.clients?.name || 'Client',
              projectName: project.name,
              milestoneTitle: m.title,
              amount: m.amount,
              currency: project.currency || 'USD',
              projectUrl: `${appUrl}/projects/${project.id}?tab=billing`,
            })
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
          projects!inner(id, name, deleted_at, clients(name))`)
        // Invoices of a soft-deleted (trashed) project are not chased or flagged
        // (section-12 audit, pass 2) — nobody can act on them from the UI.
        .is('projects.deleted_at', null)
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
          body: `${inv.projects?.clients?.name || 'Client'} has ${inv.currency} ${balanceDue.toLocaleString()} overdue on "${inv.title}"${underDispute ? ' — the client has disputed this invoice' : ''}`,
          entityType: 'project', entityId: inv.projects?.id, projectId: inv.projects?.id,
        })

        try {
          const emails = await getMemberEmailsWithPermission(service, inv.workspace_id, 'VIEW_FINANCIALS', 10, 'invoice_overdue', inv.projects?.id)
          if (emails.length) {
            await sendInvoiceOverdueInternalEmail({
              to: emails,
              clientName: inv.projects?.clients?.name || 'Client',
              projectName: inv.projects?.name,
              invoiceNumber: inv.invoice_number,
              balanceDue, currency: inv.currency,
              projectUrl: `${appUrl}/projects/${inv.projects?.id}?tab=billing`,
            })
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
            await sendTrialWarningEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              daysLeft: 0,
              upgradeUrl: `${appUrl}/settings?tab=billing`,
            })
          } catch (e) { console.error('Trial expiry email failed for', r.email, e) }
        }
      } catch (e) { run.rowError(`trial ${ws.id}`, e) }
    }
  })

  // ── 3. Grace-period reminder (before the day-GRACE_DAYS enforcement) ────────────────────
  // The window is exactly 24h wide, so each workspace lands in it on exactly one daily run; the
  // audit-log check makes a manual re-run in the same window a no-op.
  await run.step('3 grace reminder', async () => {
    const reminderDaysIn = GRACE_DAYS - GRACE_REMINDER_DAYS_LEFT
    const windowStart = new Date(now.getTime() - (reminderDaysIn + 1) * 86400000).toISOString()
    const windowEnd   = new Date(now.getTime() - reminderDaysIn * 86400000).toISOString()
    const graceReminderDue = await fetchAll<any>('grace reminder select', (from, to) =>
      (service as any).from('billing')
        .select(`workspace_id, ${WS_EMBED}`)
        .not('grace_period_started_at', 'is', null)
        .lt('grace_period_started_at', windowEnd)
        .gte('grace_period_started_at', windowStart)
        .order('workspace_id')
        .range(from, to))

    for (const b of graceReminderDue) {
      try {
        const ws = b.workspaces
        if (!ws || ws.deleted_at) continue
        const { data: alreadySent } = await (service as any)
          .from('audit_log').select('id')
          .eq('workspace_id', ws.id).eq('event_type', 'billing.payment_failed_grace_reminder')
          .gte('created_at', windowStart)
          .limit(1).maybeSingle()
        if (alreadySent) continue

        const recipients = await getBillingRecipients(service, ws.id, ws.creator)
        for (const r of recipients) {
          try {
            await sendPaymentFailedEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              upgradeUrl: `${appUrl}/settings?tab=billing`,
              graceDaysLeft: GRACE_REMINDER_DAYS_LEFT,
            })
          } catch (e) { console.error('Grace reminder email failed for', r.email, e) }
        }
        await insertAuditRow(service, {
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.payment_failed_grace_reminder', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name, metadata: { grace_days_left: GRACE_REMINDER_DAYS_LEFT },
        })
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

        const { error: downgradeErr } = await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id)
        if (downgradeErr) {
          // Put the clock back so tomorrow's run retries instead of the workspace keeping paid features
          // forever with nothing left to trigger the downgrade.
          console.error('Grace enforcement: downgrade failed, restoring grace clock:', downgradeErr.message)
          await (service as any).from('billing')
            .update({ grace_period_started_at: b.grace_period_started_at }).eq('workspace_id', b.workspace_id)
          throw new Error(`downgrade failed for ${ws.id}: ${downgradeErr.message}`)
        }

        let paystackCancelled = true
        if (b.paystack_subscription_code) {
          const r = await cancelPaystackSubscription({
            paystack_subscription_code: b.paystack_subscription_code, paystack_email_token: b.paystack_email_token,
          })
          paystackCancelled = r.ok
          if (r.ok) {
            await (service as any).from('billing')
              .update({ paystack_subscription_code: null, needs_paystack_cancel: false }).eq('workspace_id', b.workspace_id)
          } else {
            // Leave the code in place and flag it so step 4b retries — the customer must not keep being charged.
            await (service as any).from('billing')
              .update({ needs_paystack_cancel: true }).eq('workspace_id', b.workspace_id)
            await alertBillingOps(service, `billing:orphan-sub:${b.workspace_id}`, 'Downgraded workspace still has a live Paystack subscription', [
              `workspace: ${b.workspace_id}`, `subscription: ${b.paystack_subscription_code}`, `error: ${r.error}`,
              'Will be retried on every payment-overdue run (billing.needs_paystack_cancel).',
            ])
          }
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
            await sendSubscriptionEndedEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              upgradeUrl: `${appUrl}/settings?tab=billing`,
            })
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
          await (service as any).from('billing')
            .update({ paystack_subscription_code: null, needs_paystack_cancel: false }).eq('workspace_id', b.workspace_id)
        } else {
          await alertBillingOps(service, `billing:orphan-sub:${b.workspace_id}`, 'Downgraded workspace still has a live Paystack subscription', [
            `workspace: ${b.workspace_id}`, `subscription: ${b.paystack_subscription_code}`, `error: ${r.error}`,
          ], 24 * 3600_000)
        }
      } catch (e) { run.rowError(`paystack retry ${b.workspace_id}`, e) }
    }
  })

  // ── 5. Cancelled subscriptions past their paid period end ────────────────────────────────
  await run.step('5 cancelled subscriptions', async () => {
    const cancelledExpired = await fetchAll<any>('cancelled subscriptions select', (from, to) =>
      (service as any).from('billing')
        .select(`workspace_id, current_period_end, paystack_subscription_code, paystack_customer_code, ${WS_EMBED}`)
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
        const { data: guardedBilling, error: claimErr } = await (service as any).from('billing')
          .update({ cancels_at_period_end: false, paystack_subscription_code: null, paystack_customer_code: null })
          .eq('workspace_id', b.workspace_id)
          .eq('cancels_at_period_end', true)
          .lt('current_period_end', now.toISOString())
          .select('workspace_id')
        if (claimErr) throw new Error(claimErr.message)
        if (!guardedBilling?.length) continue // reactivated concurrently
        cancelledSubscriptionsEndedCount++

        // ...then downgrade. This write's error used to be ignored: if it failed, the claim above had
        // already wiped cancels_at_period_end, so nothing would ever select this workspace again and it
        // kept its paid plan for free indefinitely. (Section 4 had the same fix; this section never got it.)
        const { error: downgradeErr } = await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id)
        if (downgradeErr) {
          await (service as any).from('billing').update({
            cancels_at_period_end: true,
            paystack_subscription_code: b.paystack_subscription_code ?? null,
            paystack_customer_code: b.paystack_customer_code ?? null,
          }).eq('workspace_id', b.workspace_id)
          cancelledSubscriptionsEndedCount--
          throw new Error(`downgrade failed for ${ws.id}: ${downgradeErr.message}`)
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
            await sendSubscriptionEndedEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              upgradeUrl: `${appUrl}/settings?tab=billing`,
            })
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
