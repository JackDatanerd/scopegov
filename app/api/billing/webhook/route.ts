export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'
import { sendTrialWarningEmail, sendPaymentFailedEmail } from '@/lib/email/templates'

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
  return hash === signature
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

        // Find workspace by owner email
        const { data: user } = await (service as any)
          .from('users').select('id,active_workspace_id').eq('email', customerEmail).single()
        if (!user?.active_workspace_id) break

        const { data: prevWs } = await (service as any)
          .from('workspaces').select('plan_tier').eq('id', user.active_workspace_id).single()

        // BUG-054: planTier ONLY updated on webhook — never browser callback
        await (service as any).from('workspaces').update({
          plan_tier: newTier,
          trial_ends_at: null,
          updated_at: new Date().toISOString(),
        }).eq('id', user.active_workspace_id)

        // Store Paystack subscription code for cancellation
        await (service as any).from('billing').upsert({
          workspace_id:               user.active_workspace_id,
          paystack_customer_code:     data.customer?.customer_code,
          paystack_subscription_code: subCode,
          paystack_email_token:       data.email_token || null,
          current_period_end:         periodEnd,
          cancels_at_period_end:      false,
          grace_period_started_at:    null,
          updated_at:                 new Date().toISOString(),
        }, { onConflict: 'workspace_id' })

        await logAudit(service, {
          workspaceId: user.active_workspace_id, actorId: 'system',
          actorEmail: customerEmail, actorName: 'Paystack',
          eventType: 'billing.plan_changed', entityType: 'workspace',
          entityId: user.active_workspace_id, entityName: customerEmail,
          metadata: { from: prevWs?.plan_tier, to: newTier, plan_code: planCode },
        })
        break
      }

      // ── Renewal success ────────────────────────────────────
      case 'charge.success': {
        const customerEmail = event.data?.customer?.email
        if (!customerEmail) break
        const { data: user } = await (service as any)
          .from('users').select('id,active_workspace_id').eq('email', customerEmail).single()
        if (!user?.active_workspace_id) break

        // Clear any grace period
        await (service as any).from('billing').update({
          grace_period_started_at: null,
          updated_at: new Date().toISOString(),
        }).eq('workspace_id', user.active_workspace_id)

        await logAudit(service, {
          workspaceId: user.active_workspace_id, actorId: 'system',
          actorEmail: customerEmail, actorName: 'Paystack',
          eventType: 'billing.payment_succeeded', entityType: 'workspace',
          entityId: user.active_workspace_id, entityName: customerEmail,
          metadata: { amount: event.data?.amount },
        })
        break
      }

      // ── Payment failed — start grace period ────────────────
      case 'invoice.payment_failed': {
        const customerEmail = event.data?.customer?.email
        if (!customerEmail) break
        const { data: user } = await (service as any)
          .from('users').select('id,active_workspace_id,name').eq('email', customerEmail).single()
        if (!user?.active_workspace_id) break

        const now = new Date().toISOString()
        await (service as any).from('billing').update({
          grace_period_started_at: now,
          updated_at: now,
        }).eq('workspace_id', user.active_workspace_id)

        await logAudit(service, {
          workspaceId: user.active_workspace_id, actorId: 'system',
          actorEmail: customerEmail, actorName: 'Paystack',
          eventType: 'billing.payment_failed_grace_started', entityType: 'workspace',
          entityId: user.active_workspace_id, entityName: customerEmail, metadata: {},
        })

        // Event 28: payment failed email (awaited — carry-forward §4.4)
        try {
          await sendPaymentFailedEmail({
            to: customerEmail, name: user.name || customerEmail,
            agencyName: '',
            upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            graceDaysLeft: 5,
          })
        } catch (e) { console.error('Payment failed email error:', e) }
        break
      }

      // ── Cancellation / disable ─────────────────────────────
      case 'subscription.disable': {
        const customerEmail = event.data?.customer?.email
        if (!customerEmail) break
        const { data: user } = await (service as any)
          .from('users').select('id,active_workspace_id').eq('email', customerEmail).single()
        if (!user?.active_workspace_id) break

        await (service as any).from('billing').update({
          paystack_subscription_code: null,
          cancels_at_period_end: true,
          updated_at: new Date().toISOString(),
        }).eq('workspace_id', user.active_workspace_id)

        await logAudit(service, {
          workspaceId: user.active_workspace_id, actorId: 'system',
          actorEmail: customerEmail, actorName: 'Paystack',
          eventType: 'billing.plan_changed', entityType: 'workspace',
          entityId: user.active_workspace_id, entityName: customerEmail,
          metadata: { action: 'subscription_disabled' },
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
