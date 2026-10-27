export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { integrationAllowed, minPlanLabel, INTEGRATION_MIN_PLAN, MAX_SUBSCRIPTIONS_PER_WORKSPACE, MAX_API_KEYS_PER_WORKSPACE } from '@/lib/integrations/plans'
import { integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { INTEGRATION_EVENT_TYPES } from '@/lib/integrations/events'

// Everything the Integrations tab needs in one read: the webhooks (never their secrets), their recent delivery
// health, the API keys (never the key material), and what this plan allows. Read-only, so a lapsed workspace and a
// plan without the feature still get a truthful page (with an upgrade note) instead of an error.
export async function GET() {
  try {
    const auth = await requireIntegrationAdmin('webhook', { write: false })
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any

    const [subsRes, keysRes] = await Promise.all([
      service.from('integration_subscriptions')
        .select('id, kind, name, target_url, event_types, active, consecutive_failures, disabled_reason, last_success_at, last_failure_at, created_at')
        .eq('workspace_id', session.workspaceId).order('created_at', { ascending: true }),
      service.from('integration_api_keys')
        .select('id, name, key_prefix, created_at, last_used_at, expires_at, revoked_at')
        .eq('workspace_id', session.workspaceId).is('revoked_at', null).order('created_at', { ascending: true }),
    ])
    if (subsRes.error || keysRes.error) throw new Error(subsRes.error?.message || keysRes.error?.message)

    const subs: any[] = subsRes.data || []
    let recent: Record<string, { pending: number; succeeded: number; dead: number; last?: { status: string; code: number | null; error: string | null; at: string } }> = {}
    if (subs.length) {
      const { data: deliveries, error } = await service.from('integration_deliveries')
        .select('subscription_id, status, last_status, last_error, created_at')
        .in('subscription_id', subs.map(s => s.id)).order('created_at', { ascending: false }).limit(200)
      if (error) throw new Error(error.message)
      for (const d of deliveries || []) {
        const r = (recent[d.subscription_id] ||= { pending: 0, succeeded: 0, dead: 0 })
        if (d.status === 'pending' || d.status === 'delivering') r.pending++
        else if (d.status === 'succeeded') r.succeeded++
        else if (d.status === 'dead') r.dead++
        if (!r.last && d.status !== 'skipped') r.last = { status: d.status, code: d.last_status, error: d.last_error, at: d.created_at }
      }
    }

    return NextResponse.json({
      encryptionConfigured: integrationCryptoConfigured(),
      allowed: integrationAllowed('webhook', session.planTier, !!session.lapsed),
      lapsed: !!session.lapsed,
      minPlan: minPlanLabel('webhook'),
      nativeMinPlan: minPlanLabel('slack'),
      limits: { subscriptions: MAX_SUBSCRIPTIONS_PER_WORKSPACE, apiKeys: MAX_API_KEYS_PER_WORKSPACE },
      eventTypes: INTEGRATION_EVENT_TYPES,
      planGates: INTEGRATION_MIN_PLAN,
      subscriptions: subs.map(s => ({ ...s, health: recent[s.id] || { pending: 0, succeeded: 0, dead: 0 } })),
      apiKeys: keysRes.data || [],
    })
  } catch (err) {
    console.error('Integrations overview error:', err)
    return NextResponse.json({ error: 'Could not load integrations. Please try again.' }, { status: 500 })
  }
}
