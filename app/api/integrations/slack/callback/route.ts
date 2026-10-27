export const runtime = 'nodejs'

import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { integrationAllowed } from '@/lib/integrations/plans'
import { encryptSecret, integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { slackCall } from '@/lib/integrations/slack'
import { slackConfigured, slackRedirectUri, verifyState } from '@/lib/integrations/slack-config'

// Where Slack sends the browser back after "Allow". Everything that matters is re-checked here against the LIVE session:
// the signed state must be valid and unexpired, and must name the same workspace and the same person who is signed in now.
// The user always lands back on Settings -> Integrations with a short result code; no Slack detail is put in the URL.
const back = (request: NextRequest, result: string) => {
  const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '') || new URL(request.url).origin
  return NextResponse.redirect(`${base}/settings?tab=integrations&slack=${result}`)
}

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams
    if (q.get('error')) return back(request, 'denied') // the person pressed Cancel on Slack's page

    const check = verifyState(q.get('state'))
    if (!check.ok) return back(request, check.reason === 'expired' ? 'expired' : 'failed')

    const session = await getSession()
    if (!session || session.workspaceId !== check.state.ws || session.id !== check.state.uid) return back(request, 'failed')
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS') || session.lapsed || !integrationAllowed('slack', session.planTier, false)) return back(request, 'forbidden')
    if (!slackConfigured() || !integrationCryptoConfigured()) return back(request, 'failed')

    const code = q.get('code')
    const redirectUri = slackRedirectUri()
    if (!code || !redirectUri) return back(request, 'failed')

    const res = await slackCall('oauth.v2.access', null, {
      client_id: process.env.SLACK_CLIENT_ID!, client_secret: process.env.SLACK_CLIENT_SECRET!, code, redirect_uri: redirectUri,
    }, { form: true })
    const b = res.body
    if (!b?.ok || typeof b.access_token !== 'string' || !b.access_token.startsWith('xoxb-') || !b.team?.id) {
      console.error('Slack oauth.v2.access refused:', b?.error || `HTTP ${res.status}`)
      return back(request, 'failed')
    }

    const service = createServiceClient() as any
    const { data: existing, error: findErr } = await service.from('integration_connections')
      .select('id, config').eq('workspace_id', session.workspaceId).eq('provider', 'slack').maybeSingle()
    if (findErr) throw new Error(findErr.message)

    const id: string = existing?.id || randomUUID()
    const now = new Date().toISOString()
    const row = {
      status: 'active', display_name: String(b.team.name || '').slice(0, 120) || null, last_error: null, last_error_at: null, updated_at: now,
      credentials_enc: encryptSecret(JSON.stringify({ access_token: b.access_token }), `${session.workspaceId}:${id}`),
      config: { team_id: b.team.id, team_name: b.team.name || null, bot_user_id: b.bot_user_id || null, scope: b.scope || null, installed_by_slack_user: b.authed_user?.id || null },
    }
    if (existing) {
      const { error } = await service.from('integration_connections').update(row).eq('id', id)
      if (error) throw new Error(error.message)
      // A DIFFERENT Slack workspace invalidates every channel id stored for the old one: drop those rules. The same workspace
      // keeps them, and any the dead token had switched off are switched back on.
      if (existing.config?.team_id && existing.config.team_id !== b.team.id) {
        await service.from('integration_subscriptions').delete().eq('connection_id', id)
      } else {
        await service.from('integration_subscriptions').update({ active: true, disabled_reason: null, consecutive_failures: 0 })
          .eq('connection_id', id).like('disabled_reason', 'Slack needs to be reconnected%')
      }
    } else {
      const { error } = await service.from('integration_connections').insert({ id, workspace_id: session.workspaceId, provider: 'slack', created_by: session.id, ...row })
      if (error) throw new Error(error.message)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.slack_connected', entityType: 'integration_connection', entityId: id, entityName: b.team.name || 'Slack',
      metadata: { team_id: b.team.id, reconnect: !!existing },
    })
    return back(request, 'connected')
  } catch (err) {
    console.error('Slack callback error:', err)
    return back(request, 'failed')
  }
}
