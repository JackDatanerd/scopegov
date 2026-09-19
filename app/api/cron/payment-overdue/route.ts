export const runtime = 'nodejs'

// FIX (cron audit, section 17 — closing pass): this is the one full-scan
// cron with no maxDuration override, unlike reconciliation-rollup and
// scope-health-rollup, which both got this exact fix for the exact same
// reason — per-row fan-out with no pagination. This route runs SIX
// separate full-table-ish scans in one invocation (overdue milestones,
// overdue invoices, trial expiry, grace reminder, grace enforcement,
// cancelled subscriptions), and unlike the other two crons, several of
// these sections send a real outbound email per row — network I/O, not
// just DB writes, so the per-row cost here is higher, not lower. Without
// an override this is capped at Vercel's platform default, which a
// growing set of overdue items can exceed well before this loop finishes
// — silently truncating that day's enforcement/reminder pass with no
// catchable error. 300s matches the cap already used by this file's two
// full-scan siblings.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendTrialWarningEmail, sendPaymentFailedEmail, sendInvoiceOverdueInternalEmail, sendPaymentMilestoneOverdueEmail, sendSubscriptionEndedEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission, getMembersWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { verifyCronSecret } from '@/lib/utils/verify-cron'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

// FIX (deep audit, section 17 follow-up — flagship finding): the four
// billing-consequence emails below (trial expiry, grace reminder, grace
// enforcement, cancelled-subscription enforcement) each emailed ONLY
// workspaces.created_by — a deliberate earlier fix that moved away from
// "whichever active member happened to come back first" to "the actual
// owner." But a workspace creator is explicitly allowed to leave a
// non-trial workspace (migration 038's own comment: the trial-creator
// lockout only applies to trial-tier workspaces), and created_by is never
// reassigned unless the deliberate ownership-transfer flow runs. If the
// creator leaves and later deletes their own account — anonymizing their
// address to deleted-<uuid>@deleted.scopegov.app (see api/account/delete)
// — every one of these emails silently addresses a dead inbox forever,
// with no in-app bell either, leaving only a rarely-checked audit_log row
// as any signal. Also notifying every active member who actually holds
// MANAGE_WORKSPACE_SETTINGS (the permission that gates acting on billing
// at all — see api/billing/upgrade, resume) gives a live fallback that
// doesn't depend on one specific person staying in the workspace forever.
// Deduplicated by email so the creator (when still reachable) doesn't get
// the same email twice.
async function getBillingRecipients(
  service: any, workspaceId: string, creator: { name?: string; email?: string } | null | undefined
): Promise<Array<{ name: string; email: string }>> {
  const recipients = new Map<string, { name: string; email: string }>()
  if (creator?.email) recipients.set(creator.email, { name: creator.name || creator.email, email: creator.email })
  try {
    const admins = await getMembersWithPermission(service, workspaceId, 'MANAGE_WORKSPACE_SETTINGS', 25)
    for (const a of admins) {
      if (a.email && !recipients.has(a.email)) recipients.set(a.email, { name: a.name || a.email, email: a.email })
    }
  } catch (e) { console.error('getBillingRecipients: admin lookup failed (falling back to creator only):', e) }
  return Array.from(recipients.values())
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    const now     = new Date()

    // ── 1. Mark overdue payment milestones ─────────────────
    // FIX (cron audit, section 17 — closing pass): this used to be a
    // single bulk `.update(...).in('id', ids)` with no re-check that each
    // row was still 'pending' at write time — every other mutating step in
    // this file guards its write against the row moving between the
    // SELECT and the write (a payment/invoice being recorded is a real,
    // regular, independent event), except this one. It also never told
    // anyone: no audit_log entry, no notification, no email — unlike its
    // sibling step 1b immediately below, which does all three for overdue
    // invoices. Both gaps closed together: guard each milestone's write
    // individually, and only log/notify the ones that actually flipped.
    const { data: overdueMilestones } = await (service as any)
      .from('payment_milestones')
      .select(`id, title, amount, project_id,
        projects(id, name, workspace_id, currency, clients(name))`)
      .eq('status', 'pending')
      .not('due_date', 'is', null)
      .lt('due_date', now.toISOString().split('T')[0])

    let milestonesMarkedOverdue = 0
    for (const m of (overdueMilestones || [])) {
      try {
        const { data: updated } = await (service as any).from('payment_milestones')
          .update({ status: 'overdue' })
          .eq('id', m.id).eq('status', 'pending') // guard against a payment/invoice landing between select and update
          .select('id')

        if (!updated || updated.length === 0) continue // lost the race — already moved on

        const project = m.projects
        if (!project) continue

        await (service as any).from('audit_log').insert({
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
              projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=billing`,
            })
          }
        } catch (e) { console.error('Milestone overdue email failed:', e) }

        milestonesMarkedOverdue++
      } catch (e) { console.error('Milestone overdue processing error:', e) }
    }

    // ── 1b. Mark overdue invoices (Phase 4a) ────────────────
    // Purely date-driven — no gateway dependency either way, since
    // ScopeGov never processes the payment, only tracks its status.
    // Selecting only 'sent'/'partially_paid' means once flagged
    // 'overdue' an invoice won't be re-selected on the next run, so
    // this also naturally prevents duplicate reminder emails.
    const { data: overdueInvoices } = await (service as any)
      .from('invoices')
      .select(`id, title, amount, amount_paid, currency, invoice_number, workspace_id,
        projects(id, name, clients(name))`)
      .in('status', ['sent', 'partially_paid'])
      .not('due_date', 'is', null)
      .lt('due_date', now.toISOString().split('T')[0])

    // FIX (cron audit, section 17 — closing pass): counted below only for
    // rows that actually won the guarded UPDATE — see the note at the
    // return statement for why the raw fetched-row count was wrong.
    let invoicesMarkedOverdue = 0
    for (const inv of (overdueInvoices || [])) {
      try {
        // FIX (re-audit): same false-audit-entry-on-race gap already fixed
        // in sow-stall/co-stall — the guarded UPDATE was correct, but its
        // result was never checked before unconditionally logging + firing
        // "invoice overdue" notifications to the whole finance team. If a
        // payment landed between the SELECT above and this UPDATE (a real
        // possibility — payments and this cron are both independent,
        // regular events), the invoice is correctly left alone in the DB
        // but the team still gets told it's overdue.
        const { data: updated } = await (service as any).from('invoices')
          .update({ status: 'overdue', updated_at: now.toISOString() })
          .eq('id', inv.id).in('status', ['sent', 'partially_paid']) // guard against a payment landing between select and update
          .select('id')

        if (!updated || updated.length === 0) continue
        invoicesMarkedOverdue++

        const balanceDue = Number(inv.amount) - Number(inv.amount_paid)

        await (service as any).from('audit_log').insert({
          workspace_id: inv.workspace_id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'invoice.overdue', entity_type: 'invoice',
          entity_id: inv.id, entity_name: inv.title, metadata: { balance_due: balanceDue },
        })

        await notifyMembersWithPermission(service, {
          workspaceId: inv.workspace_id, permission: 'VIEW_FINANCIALS',
          eventType: 'invoice_overdue', type: 'invoice_overdue',
          title: `Invoice overdue — ${inv.projects?.name}`,
          body: `${inv.projects?.clients?.name || 'Client'} has ${inv.currency} ${balanceDue.toLocaleString()} overdue on "${inv.title}"`,
          entityType: 'project', entityId: inv.projects?.id, projectId: inv.projects?.id,
        })

        const emails = await getMemberEmailsWithPermission(service, inv.workspace_id, 'VIEW_FINANCIALS', 10, 'invoice_overdue', inv.projects?.id)
        if (emails.length) {
          await sendInvoiceOverdueInternalEmail({
            to: emails,
            clientName: inv.projects?.clients?.name || 'Client',
            projectName: inv.projects?.name,
            invoiceNumber: inv.invoice_number,
            balanceDue, currency: inv.currency,
            projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${inv.projects?.id}?tab=billing`,
          })
        }
      } catch (e) { console.error('Invoice overdue processing error:', e) }
    }

    // ── 2. Trial expiry enforcement ────────────────────────
    // FIX (cron audit, section 17 — closing pass): `creator:users!workspaces_created_by_fkey`
    // replaces the old `workspace_members!inner(...)` embed — the embed only
    // ever existed to derive a recipient, and "owner" below used to mean
    // "whichever active member happened to come back first," not the actual
    // workspace owner. See the same fix in sections 4 and 5 below.
    const { data: expiredTrials } = await (service as any)
      .from('workspaces')
      .select(`id, agency_name, plan_tier, trial_ends_at, created_by,
        creator:users!workspaces_created_by_fkey(name, email),
        billing(paystack_subscription_code)`)
      .eq('plan_tier', 'trial')
      .lt('trial_ends_at', now.toISOString())
      .is('deleted_at', null)

    // FIX (cron audit, section 17 — closing pass): counted below only for
    // workspaces actually downgraded by this run — see the note at the
    // return statement. The raw fetched-row count over-reports here in
    // three distinct ways: rows skipped for already having a subscription
    // on file, rows skipped for grace-period math, and rows that lost the
    // race to a concurrent invocation.
    let trialsExpiredCount = 0
    for (const ws of (expiredTrials || [])) {
      try {
        if (ws.billing?.paystack_subscription_code) {
          // Has payment on file → convert to paid plan (handled by webhook)
          continue
        }

        // Downgrade to solo (3-day grace already passed)
        const trialExpired = new Date(ws.trial_ends_at)
        const graceDays    = Math.floor((now.getTime() - trialExpired.getTime()) / 86400000)
        if (graceDays < 0) continue

        // FIX (cron audit, section 17 — closing pass): the old "already
        // logged?" pre-check was a read-then-act race — two overlapping
        // invocations (a retry, a manual trigger landing next to the
        // scheduled one) could both pass it before either inserted the
        // audit_log row, then both proceed to downgrade-and-notify. This
        // is exactly the class of gap sections 4 and 5 below already guard
        // against and section 2 never did. Guarding the UPDATE itself with
        // `.eq('plan_tier','trial')` and only continuing past it if it
        // actually matched a row makes the write itself the idempotency
        // check — a second, losing invocation sees zero rows updated and
        // stops here, before ever logging or emailing.
        const { data: updatedWs } = await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id).eq('plan_tier', 'trial')
          .select('id')

        if (!updatedWs || updatedWs.length === 0) continue // already downgraded concurrently — lost the race
        trialsExpiredCount++

        await (service as any).from('audit_log').insert({
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.trial_expired', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name,
          metadata: { converted_to: 'solo' },
        })

        // FIX (cron audit, section 17 — closing pass): notify the actual
        // workspace owner (workspaces.created_by) — trial-warning.ts
        // already caught and fixed this exact "first active member, not
        // the owner" anti-pattern for its own advance-warning email; this
        // downgrade-consequence email, arguably the more important of the
        // two, never got the same fix. In any multi-member workspace the
        // owner responsible for billing could go without ever being told
        // their workspace was downgraded.
        //
        // FIX (deep audit, section 17 follow-up): owner-only was itself a
        // single point of failure once a creator can leave — see
        // getBillingRecipients above for the full writeup.
        const recipients = await getBillingRecipients(service, ws.id, ws.creator)
        for (const r of recipients) {
          try {
            await sendTrialWarningEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              daysLeft: 0,
              upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            })
          } catch (e) { console.error('Trial expiry email failed for', r.email, e) }
        }
      } catch (e) { console.error('Trial expiry error:', e) }
    }

    // ── 3. Grace period reminder (2 days in, before day-5 enforcement) ──
    // FEATURE (cron audit, section 17): trial expiry gets escalating day-3/
    // 2/1 warnings (cron/trial-warning). Payment-failure grace period only
    // ever got a day-0 email (billing/webhook, the moment the charge
    // failed) and the day-5 downgrade email below — nothing in between, so
    // a customer who missed the first email had no further signal until
    // they were already downgraded. One midpoint nudge, reusing the same
    // template the other two grace-period emails already use.
    const graceReminderWindowStart = new Date(now.getTime() - 3 * 86400000).toISOString()
    const graceReminderWindowEnd   = new Date(now.getTime() - 2 * 86400000).toISOString()
    const { data: graceReminderDue } = await (service as any)
      .from('billing')
      .select('workspace_id, workspaces(id,agency_name,plan_tier,deleted_at,created_by,creator:users!workspaces_created_by_fkey(name,email))')
      .not('grace_period_started_at', 'is', null)
      .lt('grace_period_started_at', graceReminderWindowEnd)
      .gte('grace_period_started_at', graceReminderWindowStart)

    for (const b of (graceReminderDue || [])) {
      try {
        const ws = b.workspaces
        // FIX (build, cron/portal audit round): unlike section 2 (trial
        // expiry), which filters `.is('deleted_at', null)` directly on
        // workspaces, sections 3/4/5 here query `billing` and only embed
        // workspaces — a soft-deleted workspace's billing row isn't
        // excluded by any filter above, and deleting a workspace doesn't
        // clear grace_period_started_at/cancels_at_period_end (those only
        // change via the Paystack webhook, asynchronously, and can
        // continue arriving well after deletion — see cancelPaystackSubscription
        // in workspace/delete). Without this check, a workspace someone
        // deleted weeks ago could still get "downgraded" and its former
        // owner could still get emailed about a subscription change on a
        // workspace that no longer exists.
        if (!ws || ws.deleted_at || ws.plan_tier === 'solo') continue

        // Dedup so a daily-scheduled cron only ever sends this once per
        // grace period, even though the window above spans a full day.
        const { data: alreadySent } = await (service as any)
          .from('audit_log').select('id')
          .eq('workspace_id', ws.id).eq('event_type', 'billing.payment_failed_grace_reminder')
          .gte('created_at', graceReminderWindowStart)
          .limit(1).maybeSingle()
        if (alreadySent) continue

        // FIX (deep audit, section 17 follow-up): owner-only was a single
        // point of failure — see getBillingRecipients above.
        const recipients = await getBillingRecipients(service, ws.id, ws.creator)
        for (const r of recipients) {
          try {
            await sendPaymentFailedEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
              graceDaysLeft: 3,
            })
          } catch (e) { console.error('Grace reminder email failed for', r.email, e) }
        }

        await (service as any).from('audit_log').insert({
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.payment_failed_grace_reminder', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name, metadata: { grace_days_left: 3 },
        })
      } catch (e) { console.error('Grace reminder error:', e) }
    }

    // ── 4. Grace period enforcement (5 days after payment failure) ─
    const graceCutoff = new Date(now.getTime() - 5 * 86400000).toISOString()
    const { data: graceExpired } = await (service as any)
      .from('billing')
      .select('workspace_id, workspaces(id,agency_name,plan_tier,deleted_at,created_by,creator:users!workspaces_created_by_fkey(name,email))')
      .not('grace_period_started_at', 'is', null)
      .lt('grace_period_started_at', graceCutoff)

    for (const b of (graceExpired || [])) {
      try {
        const ws = b.workspaces
        // FIX (build, cron/portal audit round): see the identical note on
        // section 3 above — a soft-deleted workspace's billing row isn't
        // otherwise excluded here.
        if (!ws || ws.deleted_at || ws.plan_tier === 'solo') continue

        // FIX (cron audit, section 17): this used to update `workspaces`
        // unconditionally on whatever was fetched by the select above, with
        // no re-check that grace_period_started_at was still set (and still
        // past cutoff) at write time — unlike every other mutating step in
        // this same file (invoice overdue, trial expiry), which all guard
        // their update with an .eq() on the condition that qualified the
        // row. If a payment cleared the grace period in the gap between
        // select and update, this would still downgrade a customer who'd
        // just paid. Guarding the billing update itself first — and only
        // proceeding to downgrade the workspace if that guarded update
        // actually matched a row — closes the same race the other steps
        // already close.
        const { data: guardedBilling } = await (service as any).from('billing')
          .update({ grace_period_started_at: null, paystack_subscription_code: null })
          .eq('workspace_id', b.workspace_id)
          .not('grace_period_started_at', 'is', null)
          .lt('grace_period_started_at', graceCutoff)
          .select('workspace_id')

        if (!guardedBilling?.length) continue // grace period cleared concurrently — lost the race, nothing to do

        await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id)

        await (service as any).from('audit_log').insert({
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.downgraded_for_nonpayment', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name, metadata: {},
        })

        // FIX (cron audit, section 17 — closing pass): notify the actual
        // workspace owner (workspaces.created_by) — see the identical fix
        // and rationale in section 2 above.
        //
        // FIX (build, cron/portal audit round): this used to call
        // sendPaymentFailedEmail({ graceDaysLeft: 0 }) — but that template
        // is written entirely in future/prescriptive tense ("You have a
        // 0-day grace period... if not resolved within 0 days, your plan
        // will be downgraded"), sent AFTER the downgrade two blocks above
        // has already happened. sendSubscriptionEndedEmail exists
        // specifically for "the downgrade already happened, tell them
        // calmly" (see its own comment) and is already used for the
        // parallel cancelled-subscription case in section 5 below — this
        // is the same outcome (nonpayment vs. cancellation), so it gets
        // the same past-tense email instead of a reused pre-downgrade
        // warning that no longer makes sense once it's already too late.
        // FIX (deep audit, section 17 follow-up): owner-only was a single
        // point of failure — see getBillingRecipients above.
        const recipients = await getBillingRecipients(service, ws.id, ws.creator)
        for (const r of recipients) {
          try {
            await sendSubscriptionEndedEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            })
          } catch (e) { console.error('Grace enforcement email failed for', r.email, e) }
        }
      } catch (e) { console.error('Grace enforcement error:', e) }
    }

    // ── 5. Cancelled subscriptions past their paid period end ──────
    // FIX (build, cron section): app/api/billing/cancel/route.ts sets
    // cancels_at_period_end=true and app/api/billing/webhook/route.ts's
    // subscription.disable handler does the same, but nothing ever
    // checked "has this cancelled subscription's period actually ended
    // yet?" current_period_end was stored and then never read anywhere
    // except display. A workspace that cancelled and simply stopped
    // paying (no charge is ever attempted, so no charge.success /
    // invoice.payment_failed webhook fires either way) kept full paid
    // access indefinitely. This is the missing enforcement step.
    const { data: cancelledExpired } = await (service as any)
      .from('billing')
      .select('workspace_id, current_period_end, workspaces(id,agency_name,plan_tier,deleted_at,created_by,creator:users!workspaces_created_by_fkey(name,email))')
      .eq('cancels_at_period_end', true)
      .not('current_period_end', 'is', null)
      .lt('current_period_end', now.toISOString())

    // FIX (cron audit, section 17 — closing pass): same over-reporting
    // fix as trialsExpiredCount above — see the note at the return
    // statement.
    let cancelledSubscriptionsEndedCount = 0
    for (const b of (cancelledExpired || [])) {
      try {
        const ws = b.workspaces
        // FIX (build, cron/portal audit round): see the identical note on
        // section 3 above — this is the exact path that surfaced the gap:
        // deleting a workspace cancels its Paystack subscription, whose
        // async subscription.disable webhook then sets
        // cancels_at_period_end=true — which is precisely what this query
        // looks for, with no awareness the workspace is already gone.
        if (!ws || ws.deleted_at || ws.plan_tier === 'solo') continue

        // FIX (cron audit, section 17): same missing guard as the grace-
        // period step above — no re-check that cancels_at_period_end was
        // still true (and current_period_end still passed) at write time.
        // A reactivation landing between select and update would still get
        // downgraded. Guard the billing update itself and only downgrade
        // the workspace if it actually matched.
        const { data: guardedBilling } = await (service as any).from('billing')
          .update({ cancels_at_period_end: false, paystack_subscription_code: null, paystack_customer_code: null })
          .eq('workspace_id', b.workspace_id)
          .eq('cancels_at_period_end', true)
          .lt('current_period_end', now.toISOString())
          .select('workspace_id')

        if (!guardedBilling?.length) continue // reactivated concurrently — lost the race, nothing to do
        cancelledSubscriptionsEndedCount++

        await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id)

        await (service as any).from('audit_log').insert({
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.subscription_ended', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name,
          metadata: { converted_to: 'solo', period_end: b.current_period_end },
        })

        // FIX (cron audit, section 17 — closing pass): notify the actual
        // workspace owner (workspaces.created_by) — see the identical fix
        // and rationale in section 2 above.
        //
        // FIX (deep audit, section 17 follow-up): owner-only was a single
        // point of failure — see getBillingRecipients above.
        const recipients = await getBillingRecipients(service, ws.id, ws.creator)
        for (const r of recipients) {
          try {
            await sendSubscriptionEndedEmail({
              to: r.email, name: r.name, agencyName: ws.agency_name,
              upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            })
          } catch (e) { console.error('Cancelled-subscription email failed for', r.email, e) }
        }
      } catch (e) { console.error('Cancelled-subscription enforcement error:', e) }
    }

    // FIX (cron audit, section 17 — closing pass): all three counters
    // below used to report raw fetched-row counts — invoicesOverdue/
    // trialsExpired/cancelledSubscriptionsEnded counted every row the
    // initial SELECT matched, including ones later skipped for a payment
    // landing mid-run, a subscription already on file, grace-period math,
    // or losing a race to a concurrent invocation. milestonesMarkedOverdue
    // already counted correctly; reporting what this run actually did
    // for the other three, not what it merely looked at.
    return NextResponse.json({
      ok: true,
      milestonesMarkedOverdue,
      invoicesOverdue: invoicesMarkedOverdue,
      trialsExpired: trialsExpiredCount,
      cancelledSubscriptionsEnded: cancelledSubscriptionsEndedCount,
    })
  } catch (err) {
    console.error('Payment overdue cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. Exporting GET as an alias makes both invocation paths work.
//
// FIX (build, cron/portal audit round): the 3 sub-hourly jobs (sow-stall,
// co-stall, guardian-health) are now scheduled directly in vercel.json
// AND kept in .github/workflows/vercel-crons.yml as a redundant trigger
// (see that file's own comment for why both are kept intentionally) —
// this comment previously implied GitHub Actions was the only path,
// which stopped being true once vercel.json picked these three up too.
export const GET = POST
