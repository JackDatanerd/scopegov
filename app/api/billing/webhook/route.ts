export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'
import { sendTrialWarningEmail, sendPaymentFailedEmail } from '@/lib/email/templates'
import { cancelPaystackSubscription, fetchPaystackNextPaymentDate } from '@/lib/integrations/paystack'

// BUG-007 / BUG-054: Web Crypto HMAC — never import Node crypto in edge/serverless
async function verifyPaystackSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false
  const secret  = process.env.PAYSTACK_SECRET_KEY
  if (!secret)  return false
  const encoder = new TextEncoder()
  const key     = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  )
  const sig     = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  const hash    = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  return timingSafeEqualStr(hash, signature)
}

// FIX (audit round 2, item #4): plain `===` short-circuits on the first
// mismatched character — a timing side-channel for signature forgery.
// crypto.timingSafeEqual isn't usable here without importing Node's
// crypto module, which BUG-007/054 above deliberately avoids for
// edge/serverless compatibility, so this is a manual constant-time
// comparison instead: always walks the full (fixed) hash length,
// accumulating mismatches with XOR rather than branching or returning
// early on the first difference.
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Plan code → tier mapping
function planCodeToTier(planCode: string): string | null {
  const map: Record<string, string> = {
    [process.env.PAYSTACK_PLAN_SOLO_MONTHLY    || '']: 'solo',
    [process.env.PAYSTACK_PLAN_SOLO_ANNUAL     || '']: 'solo',
    [process.env.PAYSTACK_PLAN_STARTER_MONTHLY || '']: 'starter',
    [process.env.PAYSTACK_PLAN_STARTER_ANNUAL  || '']: 'starter',
    [process.env.PAYSTACK_PLAN_PRO_MONTHLY     || '']: 'pro',
    [process.env.PAYSTACK_PLAN_PRO_ANNUAL      || '']: 'pro',
    [process.env.PAYSTACK_PLAN_AGENCY_MONTHLY  || '']: 'agency',
    [process.env.PAYSTACK_PLAN_AGENCY_ANNUAL   || '']: 'agency',
  }
  return map[planCode] || null
}

// FEATURE (deep audit, Billing re-pass): see migration 045 — this is the
// missing other half of the (planKey, interval) pair api/billing/upgrade
// already checks out separately. Mirrors planCodeToTier exactly, just
// keyed on the ANNUAL half of each pair.
function planCodeToInterval(planCode: string): 'monthly' | 'annual' | null {
  const annualCodes = new Set([
    process.env.PAYSTACK_PLAN_SOLO_ANNUAL, process.env.PAYSTACK_PLAN_STARTER_ANNUAL,
    process.env.PAYSTACK_PLAN_PRO_ANNUAL, process.env.PAYSTACK_PLAN_AGENCY_ANNUAL,
  ].filter(Boolean))
  const monthlyCodes = new Set([
    process.env.PAYSTACK_PLAN_SOLO_MONTHLY, process.env.PAYSTACK_PLAN_STARTER_MONTHLY,
    process.env.PAYSTACK_PLAN_PRO_MONTHLY, process.env.PAYSTACK_PLAN_AGENCY_MONTHLY,
  ].filter(Boolean))
  if (annualCodes.has(planCode)) return 'annual'
  if (monthlyCodes.has(planCode)) return 'monthly'
  return null
}

// FEATURE (deep audit, Billing re-pass): billing.payment_method_last4/
// payment_method_type (001_initial_schema.sql) were selected on
// settings/page.tsx and never written to anywhere — a fully scaffolded
// "card on file" feature with no data behind it. Paystack's subscription
// and charge payloads both carry an `authorization` object with the
// card's last4/brand; this just reads it instead of discarding it.
function extractPaymentMethod(data: any): { last4: string | null; type: string | null } {
  const auth = data?.authorization
  return {
    last4: auth?.last4 || null,
    type:  auth?.brand || auth?.card_type || auth?.channel || null,
  }
}

// FIX (audit round 6): api/billing/upgrade deliberately captures
// session.workspaceId — the workspace actually being paid for — into
// metadata.workspaceId at checkout time. Every handler below used to
// ignore it completely and re-resolve the workspace via
// users.active_workspace_id instead, which this app's own workspace
// switcher (api/workspace/switch) lets a user change at any moment. A
// user upgrading Workspace A who switches to Workspace B before the
// webhook is delivered (webhooks are not instant) would have Workspace B
// upgraded instead — a workspace that never went through checkout —
// while Workspace A, whose owner actually paid, gets nothing. Prefer the
// metadata we generated ourselves and round-tripped through Paystack;
// only fall back to the active-workspace lookup when metadata is absent
// (e.g. a subscription created directly in the Paystack dashboard for
// support purposes) or points at a workspace that no longer exists.
async function resolveWorkspaceId(service: any, data: any, customerEmail: string): Promise<string | null> {
  const metaWorkspaceId = data?.metadata?.workspaceId
  if (metaWorkspaceId) {
    const { data: ws } = await service.from('workspaces').select('id').eq('id', metaWorkspaceId).maybeSingle()
    if (ws) return ws.id
    console.warn('billing webhook: metadata.workspaceId did not resolve to a real workspace, falling back to active_workspace_id:', metaWorkspaceId)
  }
  const { data: user } = await service.from('users').select('active_workspace_id').eq('email', customerEmail).single()
  return user?.active_workspace_id || null
}

// FIX (audit round 6): Paystack, like any payment provider, redelivers
// webhooks on timeout or a non-2xx response — nothing here recognized "I
// already processed this exact event," so a redelivery would re-send
// customer-facing emails (invoice.payment_failed's dunning email, most
// visibly) and double-log audit entries. Hash the raw request body as the
// idempotency key: a genuine redelivery sends byte-identical bytes, while
// distinct events (even of the same type, e.g. two separate failed
// invoices) always differ somewhere (timestamps at minimum) — more
// robust than trying to pick the "right" id field per event type, some
// of which don't reliably have one.
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function POST(request: NextRequest) {
  try {
    const rawBody  = await request.text()
    const sig      = request.headers.get('x-paystack-signature')

    if (!await verifyPaystackSignature(rawBody, sig)) {
      console.warn('Paystack signature verification failed')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const event   = JSON.parse(rawBody)
    const service = createServiceClient()

    console.log('Paystack webhook event:', event.event, event.data?.customer?.email)

    // FIX (audit round 6): idempotency guard — see sha256Hex's comment above.
    const idempotencyKey = `${event.event}:${await sha256Hex(rawBody)}`
    const { error: dedupeErr } = await (service as any)
      .from('processed_webhook_events').insert({ idempotency_key: idempotencyKey })
    if (dedupeErr) {
      if (dedupeErr.code === '23505') {
        console.log('Duplicate Paystack webhook delivery, skipping:', idempotencyKey)
        return NextResponse.json({ received: true, duplicate: true })
      }
      // Don't let a problem with the dedup table itself block real payment
      // processing — log and proceed rather than fail closed here.
      console.error('Could not record webhook idempotency key (proceeding anyway):', dedupeErr)
    }

    switch (event.event) {
      // ── Plan upgrade / new subscription ───────────────────
      case 'subscription.create': {
        const data         = event.data
        const customerEmail = data.customer?.email
        const planCode     = data.plan?.plan_code
        const subCode      = data.subscription_code
        const periodEnd    = data.next_payment_date

        if (!customerEmail || !planCode) break

        const newTier = planCodeToTier(planCode)
        if (!newTier) { console.warn('Unknown plan code:', planCode); break }

        // FIX (audit round 6): see resolveWorkspaceId's comment above.
        const workspaceId = await resolveWorkspaceId(service, data, customerEmail)
        if (!workspaceId) break

        const { data: prevWs } = await (service as any)
          .from('workspaces').select('plan_tier').eq('id', workspaceId).single()

        // FIX (re-audit, Billing section — CRITICAL): changing plans (the
        // Upgrade/Downgrade buttons in Settings are always active, even for
        // an already-paying workspace) opens a fresh Paystack Popup
        // checkout, which creates a BRAND NEW subscription. Nothing here
        // ever disabled the previous one before overwriting it below —
        // Paystack does not auto-cancel a customer's other subscriptions
        // when a new one is created for them, so the old subscription kept
        // renewing and charging on its own schedule, invisibly, once the
        // local record only pointed at the new one. Disable the old
        // subscription first (best-effort — a failure here must not block
        // recording the new, already-paid-for subscription; it's logged
        // loudly instead so it doesn't disappear silently).
        const { data: prevBilling } = await (service as any)
          .from('billing').select('paystack_subscription_code, paystack_email_token').eq('workspace_id', workspaceId).maybeSingle()

        if (prevBilling?.paystack_subscription_code && prevBilling.paystack_subscription_code !== subCode) {
          const cancelResult = await cancelPaystackSubscription(prevBilling)
          if (!cancelResult.ok) {
            console.error(
              `[BILLING] Failed to disable previous Paystack subscription ${prevBilling.paystack_subscription_code} ` +
              `for workspace ${workspaceId} while switching to ${subCode} — customer may now be double-billed. ` +
              `Manual intervention required: ${cancelResult.error}`
            )
          }
        }

        // BUG-054: planTier ONLY updated on webhook — never browser callback
        await (service as any).from('workspaces').update({
          plan_tier: newTier,
          trial_ends_at: null,
          updated_at: new Date().toISOString(),
        }).eq('id', workspaceId)

        // Store Paystack subscription code for cancellation
        // FEATURE (deep audit, Billing re-pass): plan_interval and
        // payment_method_last4/type were either missing entirely or
        // selected-but-never-written (see migration 045 and
        // extractPaymentMethod's comment) — populated here, at the one
        // point this app always has the full plan + authorization payload.
        const paymentMethod = extractPaymentMethod(data)
        await (service as any).from('billing').upsert({
          workspace_id:               workspaceId,
          paystack_customer_code:     data.customer?.customer_code,
          paystack_subscription_code: subCode,
          paystack_email_token:       data.email_token || null,
          current_period_end:         periodEnd,
          cancels_at_period_end:      false,
          grace_period_started_at:    null,
          plan_interval:              planCodeToInterval(planCode),
          payment_method_last4:       paymentMethod.last4,
          payment_method_type:        paymentMethod.type,
          updated_at:                 new Date().toISOString(),
        }, { onConflict: 'workspace_id' })

        // FIX (re-audit): all 4 logAudit calls in this file were actorId:
        // 'system' — an invalid uuid for the actor_id FK, so every one of
        // these inserts failed silently (see lib/utils/audit.ts). null is
        // the correct "no human actor" value for a webhook-driven event.
        await logAudit(service, {
          workspaceId, actorId: null,
          actorEmail: customerEmail, actorName: 'Paystack',
          eventType: 'billing.plan_changed', entityType: 'workspace',
          entityId: workspaceId, entityName: customerEmail,
          metadata: { from: prevWs?.plan_tier, to: newTier, plan_code: planCode, previous_subscription_disabled: prevBilling?.paystack_subscription_code && prevBilling.paystack_subscription_code !== subCode ? true : undefined },
        })
        break
      }

      // ── Renewal success ────────────────────────────────────
      case 'charge.success': {
        const customerEmail = event.data?.customer?.email
        if (!customerEmail) break
        const workspaceId = await resolveWorkspaceId(service, event.data, customerEmail)
        if (!workspaceId) break

        // FIX (re-audit, Billing section — CRITICAL): current_period_end
        // was only ever set once, in subscription.create, and never
        // refreshed here on a successful renewal charge — this app doesn't
        // handle invoice.create/invoice.update, the events Paystack's own
        // docs say carry the fresh per-cycle date. That staleness collided
        // directly with cron/payment-overdue's cancelled-subscription sweep
        // (cancels_at_period_end=true AND current_period_end < now): a
        // customer who cancels after even one successful renewal had
        // current_period_end still frozen at their very FIRST cycle's end
        // date, already in the past — so the very next cron run downgraded
        // them immediately, taking away time they'd already paid for and
        // directly contradicting what the cancel dialog itself promises
        // ("you'll keep access until the end of the current billing
        // period"). Pull the fresh next_payment_date straight from the
        // Subscription resource on every successful renewal charge.
        const { data: billingRow } = await (service as any)
          .from('billing').select('paystack_subscription_code').eq('workspace_id', workspaceId).maybeSingle()

        let nextPeriodEnd: string | null = null
        if (billingRow?.paystack_subscription_code) {
          nextPeriodEnd = await fetchPaystackNextPaymentDate(billingRow.paystack_subscription_code)
          if (!nextPeriodEnd) {
            console.error(`[BILLING] Could not refresh current_period_end for workspace ${workspaceId} after a successful charge — it will remain stale until the next successful renewal.`)
          }
        }

        // Clear any grace period, and refresh the period end if we got one
        // — a failure to refresh must not block clearing the grace period,
        // since the payment itself did succeed.
        // FEATURE (deep audit, Billing re-pass): also refresh the
        // card-on-file details here, not just at subscription.create — a
        // successful renewal charge is exactly when a previously-failing
        // card would have just been replaced/retried, and this is the
        // event most likely to reflect that.
        const paymentMethod = extractPaymentMethod(event.data)
        await (service as any).from('billing').update({
          grace_period_started_at: null,
          ...(nextPeriodEnd ? { current_period_end: nextPeriodEnd } : {}),
          ...(paymentMethod.last4 ? { payment_method_last4: paymentMethod.last4, payment_method_type: paymentMethod.type } : {}),
          updated_at: new Date().toISOString(),
        }).eq('workspace_id', workspaceId)

        await logAudit(service, {
          workspaceId, actorId: null,
          actorEmail: customerEmail, actorName: 'Paystack',
          eventType: 'billing.payment_succeeded', entityType: 'workspace',
          entityId: workspaceId, entityName: customerEmail,
          metadata: { amount: event.data?.amount },
        })
        break
      }

      // ── Payment failed — start grace period ────────────────
      case 'invoice.payment_failed': {
        const customerEmail = event.data?.customer?.email
        if (!customerEmail) break
        const workspaceId = await resolveWorkspaceId(service, event.data, customerEmail)
        if (!workspaceId) break
        const { data: user } = await (service as any)
          .from('users').select('name').eq('email', customerEmail).single()

        const now = new Date().toISOString()
        await (service as any).from('billing').update({
          grace_period_started_at: now,
          updated_at: now,
        }).eq('workspace_id', workspaceId)

        await logAudit(service, {
          workspaceId, actorId: null,
          actorEmail: customerEmail, actorName: 'Paystack',
          eventType: 'billing.payment_failed_grace_started', entityType: 'workspace',
          entityId: workspaceId, entityName: customerEmail, metadata: {},
        })

        // Event 28: payment failed email (awaited — carry-forward §4.4)
        try {
          await sendPaymentFailedEmail({
            to: customerEmail, name: user?.name || customerEmail,
            agencyName: '',
            upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            graceDaysLeft: 5,
          })
        } catch (e) { console.error('Payment failed email error:', e) }
        break
      }

      // ── Cancellation / disable ─────────────────────────────
      // FIX (re-audit, Billing section): subscription.not_renew was
      // entirely unhandled — it fell into the default case below and did
      // nothing. Per Paystack's own docs this is the event for "the
      // customer cancelled, but the current billing period hasn't ended
      // yet" — exactly this app's cancels_at_period_end concept. Handling
      // only subscription.disable meant a cancellation delivered as
      // not_renew instead left cancels_at_period_end false, so
      // cron/payment-overdue would never even consider that workspace for
      // its (now correctly guarded, see current_period_end fix above)
      // end-of-period downgrade.
      case 'subscription.disable':
      case 'subscription.not_renew': {
        const customerEmail = event.data?.customer?.email
        if (!customerEmail) break
        const workspaceId = await resolveWorkspaceId(service, event.data, customerEmail)
        if (!workspaceId) break

        // FIX (deep audit, Billing re-pass — CRITICAL): this used to
        // update by workspace_id alone, with no check that the event was
        // actually about the subscription currently on file. Look above,
        // in subscription.create: switching plans disables the customer's
        // PREVIOUS subscription server-side (cancelPaystackSubscription)
        // to stop it double-billing — and that disable call itself makes
        // Paystack fire this exact event for the now-superseded old
        // subscription, asynchronously, some time after the new
        // subscription has already been recorded. Every plan switch was
        // therefore a delayed, self-inflicted cancellation: this handler
        // would match on workspace_id, null out the brand-new (paid,
        // active) subscription code, and set cancels_at_period_end —
        // which cron/payment-overdue's cancelled-subscription sweep would
        // later act on and downgrade a paying, actively-renewing customer
        // to Solo weeks after they upgraded. Only apply this when the
        // event's own subscription_code still matches what's currently on
        // file for the workspace; a mismatch means this event is about a
        // subscription the workspace has already moved on from, not the
        // live one. (If either side is unknown — no subscription_code on
        // the payload, or no billing row yet — fall through and apply as
        // before rather than silently never cancelling anything.)
        const incomingSubCode = event.data?.subscription_code
        const { data: currentBilling } = await (service as any)
          .from('billing').select('paystack_subscription_code').eq('workspace_id', workspaceId).maybeSingle()

        if (incomingSubCode && currentBilling?.paystack_subscription_code
            && currentBilling.paystack_subscription_code !== incomingSubCode) {
          console.log(
            `Paystack ${event.event} for superseded subscription ${incomingSubCode} on workspace ${workspaceId} ` +
            `(currently on ${currentBilling.paystack_subscription_code}) — ignoring; this is expected fallout ` +
            `from a plan switch that already disabled this old subscription on purpose.`
          )
          break
        }

        await (service as any).from('billing').update({
          paystack_subscription_code: null,
          cancels_at_period_end: true,
          updated_at: new Date().toISOString(),
        }).eq('workspace_id', workspaceId)

        await logAudit(service, {
          workspaceId, actorId: null,
          actorEmail: customerEmail, actorName: 'Paystack',
          eventType: 'billing.plan_changed', entityType: 'workspace',
          entityId: workspaceId, entityName: customerEmail,
          metadata: { action: event.event === 'subscription.not_renew' ? 'subscription_not_renewing' : 'subscription_disabled' },
        })
        break
      }

      default:
        console.log('Unhandled Paystack event:', event.event)
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('Paystack webhook error:', err)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
