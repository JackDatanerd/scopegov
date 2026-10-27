// lib/integrations/slack-connection.ts
//
// Loading a workspace's Slack connection and calling Slack AS that workspace. Server-only.

import { decryptSecret, IntegrationCryptoError } from './crypto'
import { slackCall, classifySlack, type SlackCaller } from './slack'

export interface SlackConnection { id: string; workspace_id: string; status: string; config: any; credentials_enc: string | null; created_at: string; last_error: string | null }

export async function loadSlackConnection(service: any, workspaceId: string): Promise<SlackConnection | null> {
  const { data, error } = await service.from('integration_connections')
    .select('id, workspace_id, status, config, credentials_enc, created_at, last_error')
    .eq('workspace_id', workspaceId).eq('provider', 'slack').maybeSingle()
  if (error) throw new Error(error.message)
  return data || null
}

export function connectionToken(conn: SlackConnection): string {
  if (!conn.credentials_enc) throw new IntegrationCryptoError('No stored Slack token')
  const token = JSON.parse(decryptSecret(conn.credentials_enc, `${conn.workspace_id}:${conn.id}`)).access_token
  if (typeof token !== 'string' || !token) throw new IntegrationCryptoError('Stored Slack token is empty')
  return token
}

export type SlackAsResult = { ok: true; body: any } | { ok: false; error: string; reconnect: boolean }

/**
 * Call a Slack method with this workspace's bot token. A dead-token answer flags the connection and switches its rules off
 * (exactly what the delivery worker does) so the settings page says "reconnect" instead of failing mysteriously.
 */
export async function slackAs(service: any, conn: SlackConnection, method: string, payload: Record<string, unknown>, caller: SlackCaller = slackCall): Promise<SlackAsResult> {
  let token: string
  try { token = connectionToken(conn) } catch (e: any) { return { ok: false, error: 'The stored Slack connection could not be read. Reconnect Slack.', reconnect: true } }
  let res
  try { res = await caller(method, token, payload) } catch (e: any) { return { ok: false, error: 'Could not reach Slack. Please try again.', reconnect: false } }
  const v = classifySlack(res)
  if (v.outcome === 'ok') return { ok: true, body: res.body }
  if (v.outcome === 'connection_off') {
    const at = new Date().toISOString()
    await service.from('integration_connections').update({ status: 'error', last_error: v.error, last_error_at: at, updated_at: at }).eq('id', conn.id)
    await service.from('integration_subscriptions').update({ active: false, disabled_reason: v.reason }).eq('connection_id', conn.id)
    return { ok: false, error: 'Slack needs to be reconnected.', reconnect: true }
  }
  return { ok: false, error: v.error, reconnect: false }
}
