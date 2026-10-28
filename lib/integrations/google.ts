// lib/integrations/google.ts
//
// Minimal Google Drive / OAuth client plus the mapping from Google's answers to outcomes. Server-only.
// Every call goes through an injectable `GoogleCaller` so the whole flow is testable without Google.
//
// SSRF: the only hosts ever contacted are Google's own. The resumable-upload session URL comes back from Google in a
// `Location` header and is checked against the same allow-list before a single byte is sent to it.

import { GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, DRIVE_FILES_URL } from './google-config'

export interface GoogleRequest { method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; url: string; headers?: Record<string, string>; body?: string | Buffer; form?: Record<string, string>; timeoutMs?: number }
export interface GoogleResponse { status: number; json: any; location: string | null; retryAfter: string | null }
export type GoogleCaller = (req: GoogleRequest) => Promise<GoogleResponse>

const ALLOWED = [
  { host: 'oauth2.googleapis.com', prefix: '/' },
  { host: 'www.googleapis.com', prefix: '/drive/v3/' },
  { host: 'www.googleapis.com', prefix: '/upload/drive/v3/' },
]
export function isAllowedGoogleUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.port && !u.username && ALLOWED.some(a => u.hostname === a.host && u.pathname.startsWith(a.prefix))
  } catch { return false }
}

export const googleCall: GoogleCaller = async (req) => {
  if (!isAllowedGoogleUrl(req.url)) throw new Error('Refusing to call a non-Google URL')
  const headers: Record<string, string> = { ...(req.headers || {}) }
  let body: any = req.body
  if (req.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(req.form).toString() }
  const res = await fetch(req.url, { method: req.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(req.timeoutMs ?? 15_000) })
  let json: any = null
  try { const t = await res.text(); json = t && t.length < 512 * 1024 ? JSON.parse(t) : null } catch { /* not JSON */ }
  return { status: res.status, json, location: res.headers.get('location'), retryAfter: res.headers.get('retry-after') }
}

// ── errors → outcomes ────────────────────────────────────────────────────────
export type GoogleVerdict =
  | { outcome: 'ok' }
  | { outcome: 'retry'; error: string }
  | { outcome: 'permanent'; error: string }
  | { outcome: 'rule_off'; error: string; reason: string }
  | { outcome: 'connection_off'; error: string; reason: string }
  | { outcome: 'folder_gone'; error: string }

const reasonOf = (j: any): string => String(j?.error?.errors?.[0]?.reason || j?.error?.status || j?.error?.message || j?.error || '')

export function classifyGoogle(res: Pick<GoogleResponse, 'status' | 'json'>): GoogleVerdict {
  const s = res.status
  if (s >= 200 && s < 300) return { outcome: 'ok' }
  const r = reasonOf(res.json)
  if (s === 429 || s >= 500) return { outcome: 'retry', error: `Google answered HTTP ${s}` }
  if (s === 401) return { outcome: 'connection_off', error: 'Google rejected the access token', reason: 'Google Drive needs to be reconnected (access was revoked).' }
  if (s === 403) {
    if (/ratelimit|quotaexceeded$|backenderror/i.test(r) && !/storage/i.test(r)) return { outcome: 'retry', error: `Google rate limit (${r})` }
    if (/storagequotaexceeded|teamdrivefilelimitexceeded|storage/i.test(r)) return { outcome: 'rule_off', error: `Google Drive: ${r}`, reason: 'Your Google Drive storage is full, so nothing more can be archived. Free some space, then turn this back on.' }
    if (/appnotauthorizedtofile|filenotfound/i.test(r)) return { outcome: 'folder_gone', error: `Google Drive: ${r}` }
    return { outcome: 'connection_off', error: `Google Drive: ${r || 'forbidden'}`, reason: 'Google Drive refused access. Reconnect Google Drive and keep the Drive permission ticked.' }
  }
  if (s === 404) return { outcome: 'folder_gone', error: 'Google Drive: not found' }
  return { outcome: 'permanent', error: `Google Drive: ${r || `HTTP ${s}`}` }
}

/** Token endpoint failures: invalid_grant = the person revoked access (or the token expired) -> reconnect. */
export function classifyTokenError(res: Pick<GoogleResponse, 'status' | 'json'>): GoogleVerdict {
  const code = String(res.json?.error || '')
  if (res.status === 400 || res.status === 401) {
    if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client')
      return { outcome: 'connection_off', error: `Google: ${code}`, reason: 'Google Drive needs to be reconnected (access was revoked or expired).' }
    return { outcome: 'permanent', error: `Google token error: ${code || res.status}` }
  }
  if (res.status === 429 || res.status >= 500) return { outcome: 'retry', error: `Google token endpoint HTTP ${res.status}` }
  return { outcome: 'permanent', error: `Google token error HTTP ${res.status}` }
}

// ── access tokens ────────────────────────────────────────────────────────────
// Only the refresh token is stored. An access token (≈1h) is minted when needed and kept in memory for this process only.
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
export const clearTokenCache = () => tokenCache.clear()

export async function accessToken(
  connectionId: string, refreshToken: string, call: GoogleCaller, env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now(),
): Promise<{ ok: true; token: string } | { ok: false; verdict: GoogleVerdict }> {
  const hit = tokenCache.get(connectionId)
  if (hit && hit.expiresAt - 60_000 > nowMs) return { ok: true, token: hit.token }
  const res = await call({ method: 'POST', url: GOOGLE_TOKEN_URL, form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID || '', client_secret: env.GOOGLE_CLIENT_SECRET || '' } })
  if (res.status !== 200 || typeof res.json?.access_token !== 'string') return { ok: false, verdict: classifyTokenError(res) }
  tokenCache.set(connectionId, { token: res.json.access_token, expiresAt: nowMs + (Number(res.json.expires_in) || 3000) * 1000 })
  return { ok: true, token: res.json.access_token }
}
export const forgetAccessToken = (connectionId: string) => { tokenCache.delete(connectionId) }

/** Best-effort revoke of a refresh token at Google (used on disconnect). */
export async function revokeGoogleToken(refreshToken: string, call: GoogleCaller = googleCall): Promise<void> {
  try { await call({ method: 'POST', url: GOOGLE_REVOKE_URL, form: { token: refreshToken } }) } catch { /* the token is forgotten locally regardless */ }
}

/** Pull the `email` claim out of the id_token Google returned directly from its token endpoint (display only; never used for authorisation). */
export function emailFromIdToken(idToken: unknown): string | null {
  try {
    const part = String(idToken || '').split('.')[1]
    if (!part) return null
    const email = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).email
    return typeof email === 'string' && /^[^\s@<>]{1,200}@[^\s@<>]{1,200}$/.test(email) ? email : null
  } catch { return null }
}

export { DRIVE_FILES_URL }
