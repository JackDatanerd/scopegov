export const runtime = 'nodejs'

import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { integrationAllowed } from '@/lib/integrations/plans'
import { encryptSecret, integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { hubspotCall, revokeHubspotToken } from '@/lib/integrations/hubspot'
import { HUBSPOT_API, HUBSPOT_EVENT_PERMISSIONS, HUBSPOT_INTROSPECT_URL, HUBSPOT_SCOPES, HUBSPOT_TOKEN_URL, hubspotConfigured, hubspotRedirectUri, verifyHubspotState } from '@/lib/integrations/hubspot-config'

// Where HubSpot sends the browser back after "Connect app". Everything that matters is re-checked against the LIVE session: the signed
// state must be valid, unexpired and name the same workspace and person who is signed in now. The person lands on Settings ->
// Integrations with a short result code; no HubSpot detail goes in the URL.
const back = (request: NextRequest, result: string) => {
  const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '') || new URL(request.url).origin
  return NextResponse.redirect(`${base}/settings?tab=integrations&hubspot=${result}`)
}

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams
    if (q.get('error')) return back(request, 'denied')

    const check = verifyHubspotState(q.get('state'))
    if (!check.ok) return back(request, check.reason === 'expired' ? 'expired' : 'failed')

    const session = await getSession()
    if (!session || session.workspaceId !== check.state.ws || session.id !== check.state.uid) return back(request, 'failed')
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS') || !hasPermission(session, 'VIEW_CLIENT_DATA') || session.lapsed || !integrationAllowed('hubspot', session.planTier, false)) return back(request, 'forbidden')
    if (!hubspotConfigured() || !integrationCryptoConfigured()) return back(request, 'failed')

    const code = q.get('code'), redirectUri = hubspotRedirectUri()
    if (!code || !redirectUri) return back(request, 'failed')

    const ex = await hubspotCall({ method: 'POST', url: HUBSPOT_TOKEN_URL, form: {
      grant_type: 'authorization_code', client_id: process.env.HUBSPOT_CLIENT_ID!, client_secret: process.env.HUBSPOT_CLIENT_SECRET!, redirect_uri: redirectUri, code,
    } })
    const b = ex.json
    if (ex.status !== 200 || typeof b?.access_token !== 'string' || typeof b?.refresh_token !== 'string') { console.error('HubSpot token exchange refused:', b?.status || b?.error || `HTTP ${ex.status}`); return back(request, 'failed') }

    // Who and what did we just get access to? (Also proves every scope we need was granted.)
    // Token introspection (POST, token in the BODY). The v1 GET endpoint put the token in the URL and is deprecated.
    const info = await hubspotCall({ method: 'POST', url: HUBSPOT_INTROSPECT_URL, form: {
      client_id: process.env.HUBSPOT_CLIENT_ID!, client_secret: process.env.HUBSPOT_CLIENT_SECRET!, token: b.access_token, token_type_hint: 'access_token',
    } })
    const granted: string[] = Array.isArray(info.json?.scopes) ? info.json.scopes : []
    if (info.status !== 200 || info.json?.active === false || !info.json?.hub_id) { await revokeHubspotToken(b.refresh_token, hubspotCall); return back(request, 'failed') }
    if (HUBSPOT_SCOPES.some(s => !granted.includes(s))) { await revokeHubspotToken(b.refresh_token, hubspotCall); return back(request, 'scope') }
    const hubId = String(info.json.hub_id)

    // Prove the Deals API works NOW (and pick the default pipeline) so a setup problem shows on day one, not at the first signed contract.
    const pipes = await hubspotCall({ method: 'GET', url: `${HUBSPOT_API}/crm/v3/pipelines/deals`, headers: { Authorization: `Bearer ${b.access_token}` } })
    const list: any[] = Array.isArray(pipes.json?.results) ? pipes.json.results : []
    if (pipes.status !== 200 || !list.length) { console.error('HubSpot connect: could not read deal pipelines:', pipes.status); await revokeHubspotToken(b.refresh_token, hubspotCall); return back(request, 'api') }
    const defaultPipeline: string = String((list.find(p => p.id === 'default') || list[0]).id)

    const service = createServiceClient() as any
    const { data: existing, error: findErr } = await service.from('integration_connections')
      .select('id, config').eq('workspace_id', session.workspaceId).eq('provider', 'hubspot').maybeSingle()
    if (findErr) throw new Error(findErr.message)

    const id: string = existing?.id || randomUUID()
    const now = new Date().toISOString()
    const samePortal = !existing?.config?.hub_id || String(existing.config.hub_id) === hubId
    const row = {
      status: 'active', display_name: String(info.json.hub_domain || hubId).slice(0, 120), last_error: null, last_error_at: null, updated_at: now,
      credentials_enc: encryptSecret(JSON.stringify({ refresh_token: b.refresh_token }), `${session.workspaceId}:${id}`),
      config: { hub_id: hubId, hub_domain: info.json.hub_domain || null, user_email: info.json.user || null },
    }
    if (existing) {
      const { error } = await service.from('integration_connections').update(row).eq('id', id)
      if (error) throw new Error(error.message)
      // A DIFFERENT HubSpot account has none of the old account's companies, contacts or deals: forget the records.
      if (!samePortal) await service.from('integration_external_refs').delete().eq('connection_id', id)
    } else {
      const { error } = await service.from('integration_connections').insert({ id, workspace_id: session.workspaceId, provider: 'hubspot', created_by: session.id, ...row })
      if (error) throw new Error(error.message)
    }

    const mine = Object.keys(HUBSPOT_EVENT_PERMISSIONS).filter(e => hasPermission(session, HUBSPOT_EVENT_PERMISSIONS[e] as any))
    const { data: rule } = await service.from('integration_subscriptions').select('id, config').eq('connection_id', id).eq('kind', 'hubspot').maybeSingle()
    if (!rule) {
      const { error } = await service.from('integration_subscriptions').insert({
        workspace_id: session.workspaceId, connection_id: id, kind: 'hubspot', name: 'HubSpot sync', target_url: `${HUBSPOT_API}/crm/v3/objects`,
        event_types: mine, secret_enc: null, created_by: session.id, config: { pipeline_id: defaultPipeline, include_amounts: false },
      })
      if (error && (error as any).code !== '23505') throw new Error(error.message)
    } else {
      // Reconnecting switches the rule back on if (and only if) a dead token was why it was off. A new portal needs a pipeline from THAT portal.
      await service.from('integration_subscriptions').update({ active: true, disabled_reason: null, consecutive_failures: 0 })
        .eq('id', rule.id).like('disabled_reason', 'HubSpot needs to be reconnected%')
      if (!samePortal) await service.from('integration_subscriptions').update({ config: { ...(rule.config || {}), pipeline_id: defaultPipeline } }).eq('id', rule.id)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.hubspot_connected', entityType: 'integration_connection', entityId: id, entityName: String(info.json.hub_domain || hubId),
      metadata: { reconnect: !!existing, same_portal: samePortal, hub_id: hubId },
    })
    return back(request, 'connected')
  } catch (err) {
    console.error('HubSpot callback error:', err)
    return back(request, 'failed')
  }
}
