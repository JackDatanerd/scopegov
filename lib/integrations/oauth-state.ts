// lib/integrations/oauth-state.ts
//
// The OAuth `state` token shared by every "connect your account" flow (Slack, Google Drive; HubSpot next). It is the CSRF
// defence for the redirect round-trip: signed (HMAC-SHA256, keyed from INTEGRATIONS_ENCRYPTION_KEY), expiring (10 min), and bound
// to the workspace AND the person who started it. `purpose` is mixed into the signature, so a state minted for Slack can never
// be accepted by the Google callback (or the reverse). Server-only (node:crypto).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const STATE_TTL_MS = 10 * 60 * 1000
export interface OAuthState { ws: string; uid: string }
export type StateCheck = { ok: true; state: OAuthState } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }

function stateKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.INTEGRATIONS_ENCRYPTION_KEY
  const key = raw ? Buffer.from(raw.trim(), 'base64') : Buffer.alloc(0)
  if (key.length !== 32) throw new Error('INTEGRATIONS_ENCRYPTION_KEY is not configured')
  return key
}
const mac = (purpose: string, payload: string, env: NodeJS.ProcessEnv) =>
  createHmac('sha256', stateKey(env)).update(`${purpose}-oauth-state.v1:${payload}`).digest('base64url')

export function signOAuthState(purpose: string, s: OAuthState, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const payload = Buffer.from(JSON.stringify({ ws: s.ws, uid: s.uid, exp: nowMs + STATE_TTL_MS, n: randomBytes(12).toString('base64url') })).toString('base64url')
  return `${payload}.${mac(purpose, payload, env)}`
}

export function verifyOAuthState(purpose: string, token: string | null | undefined, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): StateCheck {
  const [payload, sig, extra] = String(token || '').split('.')
  if (!payload || !sig || extra !== undefined) return { ok: false, reason: 'malformed' }
  const want = Buffer.from(mac(purpose, payload, env)), got = Buffer.from(sig)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'bad_signature' }
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof p.ws !== 'string' || typeof p.uid !== 'string' || typeof p.exp !== 'number') return { ok: false, reason: 'malformed' }
    if (p.exp < nowMs) return { ok: false, reason: 'expired' }
    return { ok: true, state: { ws: p.ws, uid: p.uid } }
  } catch { return { ok: false, reason: 'malformed' } }
}
