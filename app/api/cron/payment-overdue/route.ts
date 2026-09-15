export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendTrialWarningEmail, sendPaymentFailedEmail, sendInvoiceOverdueInternalEmail, sendSubscriptionEndedEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { verifyCronSecret } from '@/lib/utils/verify-cron'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    const now     = new Date()

    // ── 1. Mark overdue payment milestones ─────────────────
    const { data: overdueMilestones } = await (service as any)
      .from('payment_milestones')
      .select('id')
      .eq('status', 'pending')
      .not('due_date', 'is', null)
      .lt('due_date', now.toISOString().split('T')[0])

    if (overdueMilestones?.length) {
      await (service as any).from('payment_milestones')
        .update({ status: 'overdue' })
        .in('id', overdueMilestones.map((m: any) => m.id))
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

    for (const inv of (overdueInvoices || [])) {
      try {
        await (service as any).from('invoices')
          .update({ status: 'overdue', updated_at: now.toISOString() })
          .eq('id', inv.id).in('status', ['sent', 'partially_paid']) // guard against a payment landing between select and update

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
          // FIX (audit): entity_type was 'invoice' — NotificationBell's entityHref()
          // has no case for 'invoice', so this notification was an unclickable dead
          // end. Point at the project's Billing tab like every other notification
          // type does.
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
    const { data: expiredTrials } = await (service as any)
      .from('workspaces')
      .select(`id, agency_name, plan_tier, trial_ends_at,
        billing(paystack_subscription_code),
        workspace_members!inner(user_id, status, users!inner(name, email))`)
      .eq('plan_tier', 'trial')
      .lt('trial_ends_at', now.toISOString())
      .is('deleted_at', null)

    for (const ws of (expiredTrials || [])) {
      try {
        if (ws.billing?.paystack_subscription_code) {
          // Has payment on file → convert to paid plan (handled by webhook)
          continue
        }

        // Downgrade to solo (3-day grace already passed)
        const trialExpired = new Date(ws.trial_ends_at)
        const graceDays    = Math.floor((now.getTime() - trialExpired.getTime()) / 86400000)

        if (graceDays >= 0) {
          // Check if already downgraded
          const { data: alreadyLogged } = await (service as any)
            .from('audit_log').select('id')
            .eq('workspace_id', ws.id).eq('event_type', 'billing.trial_expired').limit(1).single()

          if (!alreadyLogged) {
            // Convert to Solo (solo: 2 projects, 1 seat)
            await (service as any).from('workspaces')
              .update({ plan_tier: 'solo', updated_at: now.toISOString() })
              .eq('id', ws.id).eq('plan_tier', 'trial')

            await (service as any).from('audit_log').insert({
              workspace_id: ws.id, actor_id: null,
              actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
              event_type: 'billing.trial_expired', entity_type: 'workspace',
              entity_id: ws.id, entity_name: ws.agency_name,
              metadata: { converted_to: 'solo' },
            })

            // Notify owner (Event 27)
            const owner = (ws.workspace_members || [])
              .filter((m: any) => m.status === 'active')
              .map((m: any) => m.users)[0]
            if (owner) {
              await sendTrialWarningEmail({
                to: owner.email, name: owner.name, agencyName: ws.agency_name,
                daysLeft: 0,
                upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
              })
            }
          }
        }
      } catch (e) { console.error('Trial expiry error:', e) }
    }

    // ── 3. Grace period enforcement (5 days after payment failure) ─
    const graceCutoff = new Date(now.getTime() - 5 * 86400000).toISOString()
    const { data: graceExpired } = await (service as any)
      .from('billing')
      .select('workspace_id, workspaces(id,agency_name,plan_tier,workspace_members!inner(user_id,status,users!inner(name,email)))')
      .not('grace_period_started_at', 'is', null)
      .lt('grace_period_started_at', graceCutoff)

    for (const b of (graceExpired || [])) {
      try {
        const ws = b.workspaces
        if (!ws || ws.plan_tier === 'solo') continue

        await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id)

        await (service as any).from('billing')
          .update({ grace_period_started_at: null, paystack_subscription_code: null })
          .eq('workspace_id', b.workspace_id)

        await (service as any).from('audit_log').insert({
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.downgraded_for_nonpayment', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name, metadata: {},
        })

        // Event 29: send downgrade notification
        const owner = (ws.workspace_members || [])
          .filter((m: any) => m.status === 'active')
          .map((m: any) => m.users)[0]
        if (owner) {
          await sendPaymentFailedEmail({
            to: owner.email, name: owner.name, agencyName: ws.agency_name,
            upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            graceDaysLeft: 0,
          })
        }
      } catch (e) { console.error('Grace enforcement error:', e) }
    }

    // ── 4. Cancelled subscriptions past their paid period end ──────
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
      .select('workspace_id, current_period_end, workspaces(id,agency_name,plan_tier,workspace_members!inner(user_id,status,users!inner(name,email)))')
      .eq('cancels_at_period_end', true)
      .not('current_period_end', 'is', null)
      .lt('current_period_end', now.toISOString())

    for (const b of (cancelledExpired || [])) {
      try {
        const ws = b.workspaces
        if (!ws || ws.plan_tier === 'solo') continue

        await (service as any).from('workspaces')
          .update({ plan_tier: 'solo', updated_at: now.toISOString() })
          .eq('id', ws.id)

        await (service as any).from('billing')
          .update({ cancels_at_period_end: false, paystack_subscription_code: null, paystack_customer_code: null })
          .eq('workspace_id', b.workspace_id)

        await (service as any).from('audit_log').insert({
          workspace_id: ws.id, actor_id: null,
          actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
          event_type: 'billing.subscription_ended', entity_type: 'workspace',
          entity_id: ws.id, entity_name: ws.agency_name,
          metadata: { converted_to: 'solo', period_end: b.current_period_end },
        })

        const owner = (ws.workspace_members || [])
          .filter((m: any) => m.status === 'active')
          .map((m: any) => m.users)[0]
        if (owner) {
          await sendSubscriptionEndedEmail({
            to: owner.email, name: owner.name, agencyName: ws.agency_name,
            upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
          })
        }
      } catch (e) { console.error('Cancelled-subscription enforcement error:', e) }
    }

    return NextResponse.json({
      ok: true,
      overdueMarked: overdueMilestones?.length || 0,
      invoicesOverdue: overdueInvoices?.length || 0,
      trialsExpired: expiredTrials?.length || 0,
      cancelledSubscriptionsEnded: cancelledExpired?.length || 0,
    })
  } catch (err) {
    console.error('Payment overdue cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. The 3 sub-hourly jobs (sow-stall, co-stall, guardian-health) are
// triggered by the GitHub Actions workflow via POST, which still works.
// Exporting GET as an alias makes both invocation paths work.
export const GET = POST
