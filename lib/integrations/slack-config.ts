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

import { signOAuthState, verifyOAuthState, STATE_TTL_MS as TTL, type OAuthState, type StateCheck as Check } from './oauth-state'

export const SLACK_API = 'https://slack.com/api'
export const SLACK_POST_URL = `${SLACK_API}/chat.postMessage`
/** chat:write(.public) post; channels/groups:read list the channels to pick from. Nothing that reads message history. */
export const SLACK_SCOPES = ['chat:write', 'chat:write.public', 'channels:read', 'groups:read'] as const
export const STATE_TTL_MS = TTL

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

export type SlackState = OAuthState
export type StateCheck = Check

export const signState = (s: SlackState, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): string => signOAuthState('slack', s, nowMs, env)
export const verifyState = (token: string | null | undefined, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): StateCheck => verifyOAuthState('slack', token, nowMs, env)
