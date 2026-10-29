// lib/integrations/hubspot.ts
//
// Minimal HubSpot CRM client plus the mapping from HubSpot's answers to outcomes. Server-only. Every call goes through an
// injectable `HubspotCaller`, so the whole sync is testable without HubSpot. Only api.hubapi.com is ever contacted.

import { HUBSPOT_API, HUBSPOT_TOKEN_URL } from './hubspot-config'

export interface HubspotRequest { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; headers?: Record<string, string>; json?: unknown; form?: Record<string, string>; timeoutMs?: number }
export interface HubspotResponse { status: number; json: any; retryAfter: string | null }
export type HubspotCaller = (req: HubspotRequest) => Promise<HubspotResponse>

export function isAllowedHubspotUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && u.hostname === 'api.hubapi.com' && !u.port && !u.username && (u.pathname.startsWith('/crm/') || u.pathname.startsWith('/oauth/'))
  } catch { return false }
}

export const hubspotCall: HubspotCaller = async (req) => {
  if (!isAllowedHubspotUrl(req.url)) throw new Error('Refusing to call a non-HubSpot URL')
  const headers: Record<string, string> = { ...(req.headers || {}) }
  let body: string | undefined
  if (req.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(req.form).toString() }
  else if (req.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(req.json) }
  const res = await fetch(req.url, { method: req.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(req.timeoutMs ?? 15_000) })
  let json: any = null
  try { const t = await res.text(); json = t && t.length < 512 * 1024 ? JSON.parse(t) : null } catch { /* empty or not JSON */ }
  return { status: res.status, json, retryAfter: res.headers.get('retry-after') }
}

// ── errors → outcomes ────────────────────────────────────────────────────────
export type HubspotVerdict =
  | { outcome: 'ok' }
  | { outcome: 'retry'; error: string }
  | { outcome: 'permanent'; error: string }
  | { outcome: 'not_found'; error: string }
  | { outcome: 'rule_off'; error: string; reason: string }
  | { outcome: 'connection_off'; error: string; reason: string }

const msgOf = (j: any): string => String(j?.message || j?.error_description || j?.error || '').slice(0, 300)

export function classifyHubspot(res: Pick<HubspotResponse, 'status' | 'json'>): HubspotVerdict {
  const s = res.status, cat = String(res.json?.category || ''), msg = msgOf(res.json)
  if (s >= 200 && s < 300) return { outcome: 'ok' }
  if (s === 429 || cat === 'RATE_LIMITS') return { outcome: 'retry', error: 'HubSpot rate limit' }
  if (s >= 500) return { outcome: 'retry', error: `HubSpot answered HTTP ${s}` }
  if (s === 401) return { outcome: 'connection_off', error: `HubSpot rejected the access token${msg ? ` (${msg})` : ''}`, reason: 'HubSpot needs to be reconnected (access was revoked or expired).' }
  if (s === 403) return { outcome: 'connection_off', error: `HubSpot: ${cat || 'forbidden'}${msg ? ` — ${msg}` : ''}`, reason: 'HubSpot refused access. Reconnect HubSpot and accept all of the requested permissions.' }
  if (s === 404) return { outcome: 'not_found', error: 'HubSpot: not found' }
  if (s === 409) return { outcome: 'retry', error: `HubSpot conflict${msg ? `: ${msg}` : ''}` }
  if (s === 400 && /pipeline|dealstage|stage/i.test(msg)) return { outcome: 'rule_off', error: `HubSpot: ${msg}`, reason: 'The selected HubSpot pipeline or stage is no longer valid. Choose a pipeline again, then turn this back on.' }
  return { outcome: 'permanent', error: `HubSpot: ${msg || `HTTP ${s}`}` }
}

/** Token endpoint failures. BAD_REFRESH_TOKEN / invalid_grant = access revoked -> reconnect. */
export function classifyHubspotToken(res: Pick<HubspotResponse, 'status' | 'json'>): HubspotVerdict {
  const code = String(res.json?.status || res.json?.error || '')
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    if (/BAD_REFRESH_TOKEN|invalid_grant|BAD_AUTH_CODE|invalid_client|BAD_CLIENT/i.test(code) || /refresh token|revoked|expired/i.test(msgOf(res.json)))
      return { outcome: 'connection_off', error: `HubSpot: ${code || 'token refused'}`, reason: 'HubSpot needs to be reconnected (access was revoked or expired).' }
    return { outcome: 'permanent', error: `HubSpot token error: ${code || res.status}` }
  }
  if (res.status === 429 || res.status >= 500) return { outcome: 'retry', error: `HubSpot token endpoint HTTP ${res.status}` }
  return { outcome: 'permanent', error: `HubSpot token error HTTP ${res.status}` }
}

// ── access tokens (30 minutes) — only the refresh token is stored ────────────
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
export const clearHubspotTokenCache = () => tokenCache.clear()
export const forgetHubspotToken = (connectionId: string) => { tokenCache.delete(connectionId) }

export async function hubspotAccessToken(
  connectionId: string, refreshToken: string, call: HubspotCaller, env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now(),
): Promise<{ ok: true; token: string } | { ok: false; verdict: HubspotVerdict }> {
  const hit = tokenCache.get(connectionId)
  if (hit && hit.expiresAt - 60_000 > nowMs) return { ok: true, token: hit.token }
  const res = await call({ method: 'POST', url: HUBSPOT_TOKEN_URL, form: { grant_type: 'refresh_token', client_id: env.HUBSPOT_CLIENT_ID || '', client_secret: env.HUBSPOT_CLIENT_SECRET || '', refresh_token: refreshToken } })
  if (res.status !== 200 || typeof res.json?.access_token !== 'string') return { ok: false, verdict: classifyHubspotToken(res) }
  tokenCache.set(connectionId, { token: res.json.access_token, expiresAt: nowMs + (Number(res.json.expires_in) || 1800) * 1000 })
  return { ok: true, token: res.json.access_token }
}

/** Best-effort revoke of a refresh token at HubSpot (disconnect). */
export async function revokeHubspotToken(refreshToken: string, call: HubspotCaller = hubspotCall): Promise<void> {
  try { await call({ method: 'DELETE', url: `${HUBSPOT_API}/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}` }) } catch { /* forgotten locally regardless */ }
}

// ── deal pipelines ───────────────────────────────────────────────────────────
export interface PipelineStages { id: string; label: string; open: string | null; won: string | null; lost: string | null }

/** Find the open / won / lost stage ids of a deal pipeline from HubSpot's own stage metadata (isClosed + probability). */
export function stagesOf(pipeline: any): PipelineStages {
  const stages: any[] = [...(pipeline?.stages || [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
  const closed = (s: any) => String(s?.metadata?.isClosed) === 'true'
  const prob = (s: any) => Number(s?.metadata?.probability)
  return {
    id: String(pipeline?.id ?? ''), label: String(pipeline?.label ?? ''),
    open: stages.find(s => !closed(s))?.id ?? null,
    won: stages.find(s => closed(s) && prob(s) >= 1)?.id ?? null,
    lost: stages.find(s => closed(s) && prob(s) === 0)?.id ?? null,
  }
}
