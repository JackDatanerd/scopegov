export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { integrationAllowed, minPlanLabel, INTEGRATION_MIN_PLAN, MAX_SUBSCRIPTIONS_PER_WORKSPACE, MAX_API_KEYS_PER_WORKSPACE } from '@/lib/integrations/plans'
import { integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { INTEGRATION_EVENT_TYPES } from '@/lib/integrations/events'
import { slackConfigured } from '@/lib/integrations/slack-config'
import { googleConfigured, driveFolderUrl } from '@/lib/integrations/google-config'
import { DRIVE_EVENT_LABELS } from '@/lib/integrations/drive-config'

// Everything the Integrations tab needs in one read: the webhooks (never their secrets), their recent delivery
// health, the API keys (never the key material), and what this plan allows. Read-only, so a lapsed workspace and a
// plan without the feature still get a truthful page (with an upgrade note) instead of an error.
export async function GET() {
  try {
    const auth = await requireIntegrationAdmin('webhook', { write: false })
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any

    const [subsRes, keysRes, connRes, driveConnRes] = await Promise.all([
      service.from('integration_subscriptions')
        .select('id, kind, name, target_url, event_types, config, active, consecutive_failures, disabled_reason, last_success_at, last_failure_at, created_at')
        .eq('workspace_id', session.workspaceId).order('created_at', { ascending: true }),
      service.from('integration_api_keys')
        .select('id, name, key_prefix, created_at, last_used_at, expires_at, revoked_at')
        .eq('workspace_id', session.workspaceId).is('revoked_at', null).order('created_at', { ascending: true }),
      service.from('integration_connections').select('status, display_name, config, last_error, created_at').eq('workspace_id', session.workspaceId).eq('provider', 'slack').maybeSingle(),
      service.from('integration_connections').select('id, status, display_name, config, last_error, created_at').eq('workspace_id', session.workspaceId).eq('provider', 'google_drive').maybeSingle(),
    ])
    if (subsRes.error || keysRes.error || connRes.error || driveConnRes.error) throw new Error(subsRes.error?.message || keysRes.error?.message || connRes.error?.message || driveConnRes.error?.message)
    const slackConn = connRes.data
    const driveConn = driveConnRes.data
    let driveRoot: string | null = null, driveArchived = 0
    if (driveConn) {
      const [rootRes, countRes] = await Promise.all([
        service.from('integration_external_refs').select('remote_id').eq('connection_id', driveConn.id).eq('ref_type', 'folder').eq('local_key', `root:${session.workspaceId}`).maybeSingle(),
        service.from('integration_external_refs').select('id', { count: 'exact', head: true }).eq('connection_id', driveConn.id).eq('ref_type', 'file'),
      ])
      driveRoot = rootRes.data?.remote_id || null
      driveArchived = countRes.count ?? 0
    }
    const driveRule = (driveConn ? subsRes.data || [] : []).find((s: any) => s.kind === 'google_drive')

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
      subscriptions: subs.filter(s => s.kind !== 'slack' && s.kind !== 'google_drive').map(({ config: _c, ...s }) => ({ ...s, health: recent[s.id] || { pending: 0, succeeded: 0, dead: 0 } })),
      apiKeys: keysRes.data || [],
      drive: {
        configured: googleConfigured(),
        allowed: integrationAllowed('google_drive', session.planTier, !!session.lapsed),
        eventLabels: DRIVE_EVENT_LABELS,
        archived: driveArchived,
        connection: driveConn ? { account_email: driveConn.config?.account_email || driveConn.display_name || null, status: driveConn.status, last_error: driveConn.last_error, connected_at: driveConn.created_at, folder_url: driveRoot ? driveFolderUrl(driveRoot) : null } : null,
        rule: driveRule ? { event_types: driveRule.event_types, active: driveRule.active, disabled_reason: driveRule.disabled_reason, last_success_at: driveRule.last_success_at, health: recent[driveRule.id] || { pending: 0, succeeded: 0, dead: 0 } } : null,
      },
      slack: {
        configured: slackConfigured(),
        allowed: integrationAllowed('slack', session.planTier, !!session.lapsed),
        connection: slackConn ? { team_name: slackConn.config?.team_name || slackConn.display_name || null, status: slackConn.status, last_error: slackConn.last_error, connected_at: slackConn.created_at } : null,
        rules: subs.filter(s => s.kind === 'slack').map(s => ({ id: s.id, channel: s.config?.channel_name || s.name, is_private: !!s.config?.is_private, event_types: s.event_types, active: s.active, disabled_reason: s.disabled_reason, last_success_at: s.last_success_at, health: recent[s.id] || { pending: 0, succeeded: 0, dead: 0 } })),
      },
    })
  } catch (err) {
    console.error('Integrations overview error:', err)
    return NextResponse.json({ error: 'Could not load integrations. Please try again.' }, { status: 500 })
  }
}
