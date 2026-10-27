// lib/integrations/slack-config.ts
//
// Slack app configuration and the OAuth `state` token. Server-only (node:crypto).
//
//   SLACK_CLIENT_ID / SLACK_CLIENT_SECRET   from the Slack app (api.slack.com/apps -> Basic Information).
// The redirect URL registered in the Slack app must be exactly  ${NEXT_PUBLIC_APP_URL}/api/integrations/slack/callback
// (integrations/slack/manifest.json already says so).
//
// `state` is the OAuth CSRF defence: signed (HMAC-SHA256, keyed from INTEGRATIONS_ENCRYPTION_KEY), expiring (10 min), and
// bound to the workspace AND the user who started the flow. The callback re-checks all three against the live session, so a
// link started by one person cannot be completed by another, replayed later, or pointed at a different workspace.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SLACK_API = 'https://slack.com/api'
export const SLACK_POST_URL = `${SLACK_API}/chat.postMessage`
/** chat:write(.public) post; channels/groups:read list the channels to pick from. Nothing that reads message history. */
export const SLACK_SCOPES = ['chat:write', 'chat:write.public', 'channels:read', 'groups:read'] as const
export const STATE_TTL_MS = 10 * 60 * 1000

export function slackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET)
}

export function slackRedirectUri(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
  return /^https?:\/\//.test(base) ? `${base}/api/integrations/slack/callback` : null
}

export function slackAuthorizeUrl(state: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const redirect = slackRedirectUri(env)
  if (!slackConfigured(env) || !redirect) return null
  const q = new URLSearchParams({ client_id: env.SLACK_CLIENT_ID!, scope: SLACK_SCOPES.join(','), redirect_uri: redirect, state })
  return `https://slack.com/oauth/v2/authorize?${q}`
}

function stateKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.INTEGRATIONS_ENCRYPTION_KEY
  const key = raw ? Buffer.from(raw.trim(), 'base64') : Buffer.alloc(0)
  if (key.length !== 32) throw new Error('INTEGRATIONS_ENCRYPTION_KEY is not configured')
  return key
}
const mac = (payload: string, env: NodeJS.ProcessEnv) => createHmac('sha256', stateKey(env)).update('slack-oauth-state.v1:' + payload).digest('base64url')

export interface SlackState { ws: string; uid: string }

export function signState(s: SlackState, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const payload = Buffer.from(JSON.stringify({ ws: s.ws, uid: s.uid, exp: nowMs + STATE_TTL_MS, n: randomBytes(12).toString('base64url') })).toString('base64url')
  return `${payload}.${mac(payload, env)}`
}

export type StateCheck = { ok: true; state: SlackState } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }

export function verifyState(token: string | null | undefined, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): StateCheck {
  const [payload, sig, extra] = String(token || '').split('.')
  if (!payload || !sig || extra !== undefined) return { ok: false, reason: 'malformed' }
  const want = Buffer.from(mac(payload, env)), got = Buffer.from(sig)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'bad_signature' }
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof p.ws !== 'string' || typeof p.uid !== 'string' || typeof p.exp !== 'number') return { ok: false, reason: 'malformed' }
    if (p.exp < nowMs) return { ok: false, reason: 'expired' }
    return { ok: true, state: { ws: p.ws, uid: p.uid } }
  } catch { return { ok: false, reason: 'malformed' } }
}
