// lib/integrations/hubspot-connection.ts
//
// Loading a workspace's HubSpot connection and calling HubSpot AS that workspace. Server-only.

import { decryptSecret } from './crypto'
import { HUBSPOT_API } from './hubspot-config'
import { classifyHubspot, hubspotAccessToken, hubspotCall, forgetHubspotToken, type HubspotCaller } from './hubspot'

export interface HubspotConnection { id: string; workspace_id: string; status: string; config: any; credentials_enc: string | null; created_at: string; last_error: string | null }

export async function loadHubspotConnection(service: any, workspaceId: string): Promise<HubspotConnection | null> {
  const { data, error } = await service.from('integration_connections')
    .select('id, workspace_id, status, config, credentials_enc, created_at, last_error')
    .eq('workspace_id', workspaceId).eq('provider', 'hubspot').maybeSingle()
  if (error) throw new Error(error.message)
  return data || null
}

export function hubspotRefreshToken(conn: Pick<HubspotConnection, 'id' | 'workspace_id' | 'credentials_enc'>): string {
  const t = JSON.parse(decryptSecret(conn.credentials_enc || '', `${conn.workspace_id}:${conn.id}`)).refresh_token
  if (typeof t !== 'string' || !t) throw new Error('No stored HubSpot token')
  return t
}

export type HubspotAsResult = { ok: true; json: any } | { ok: false; error: string; reconnect: boolean }

/** Call HubSpot with this workspace's token. A dead token flags the connection and switches its rule off (as the delivery worker does). */
export async function hubspotAs(service: any, conn: HubspotConnection, method: 'GET' | 'POST' | 'PATCH', path: string, json?: unknown, call: HubspotCaller = hubspotCall): Promise<HubspotAsResult> {
  let refresh: string
  try { refresh = hubspotRefreshToken(conn) } catch { return { ok: false, error: 'The stored HubSpot connection could not be read. Reconnect HubSpot.', reconnect: true } }
  const t = await hubspotAccessToken(conn.id, refresh, call)
  if (!t.ok) return fault(service, conn, t.verdict)
  let res
  try { res = await call({ method, url: `${HUBSPOT_API}${path}`, headers: { Authorization: `Bearer ${t.token}` }, json }) } catch { return { ok: false, error: 'Could not reach HubSpot. Please try again.', reconnect: false } }
  if (res.status === 401) {
    forgetHubspotToken(conn.id)
    const t2 = await hubspotAccessToken(conn.id, refresh, call)
    if (!t2.ok) return fault(service, conn, t2.verdict)
    try { res = await call({ method, url: `${HUBSPOT_API}${path}`, headers: { Authorization: `Bearer ${t2.token}` }, json }) } catch { return { ok: false, error: 'Could not reach HubSpot. Please try again.', reconnect: false } }
  }
  const v = classifyHubspot(res)
  if (v.outcome === 'ok') return { ok: true, json: res.json }
  return fault(service, conn, v)
}

async function fault(service: any, conn: HubspotConnection, v: any): Promise<HubspotAsResult> {
  if (v.outcome === 'connection_off') {
    const at = new Date().toISOString()
    await service.from('integration_connections').update({ status: 'error', last_error: v.error, last_error_at: at, updated_at: at }).eq('id', conn.id)
    await service.from('integration_subscriptions').update({ active: false, disabled_reason: v.reason }).eq('connection_id', conn.id)
    return { ok: false, error: 'HubSpot needs to be reconnected.', reconnect: true }
  }
  return { ok: false, error: v.error || 'HubSpot error', reconnect: false }
}
