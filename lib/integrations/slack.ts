// lib/integrations/slack.ts
//
// Thin Slack Web API client + the mapping from Slack's answers to delivery outcomes.
//
// Slack answers HTTP 200 with { ok: false, error } for most failures, so the BODY decides, not the status. The host is a
// constant (never tenant-supplied), so this uses plain fetch rather than the pinned-request path built for customer URLs.

import { SLACK_API } from './slack-config'

export interface SlackResponse { status: number; retryAfter: string | null; body: any }
export type SlackCaller = (method: string, token: string | null, payload: Record<string, unknown>, opts?: { form?: boolean }) => Promise<SlackResponse>

const METHOD = /^[a-z]+(\.[a-zA-Z]+)+$/
const MAX_BODY = 256 * 1024
const TIMEOUT_MS = 8_000

export const slackCall: SlackCaller = async (method, token, payload, opts = {}) => {
  if (!METHOD.test(method)) throw new Error(`Refusing to call an unexpected Slack method: ${method}`)
  const headers: Record<string, string> = opts.form
    ? { 'Content-Type': 'application/x-www-form-urlencoded' }
    : { 'Content-Type': 'application/json; charset=utf-8' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST', headers, redirect: 'error',
    body: opts.form ? new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  let body: any = null
  try { const text = await res.text(); body = text.length <= MAX_BODY ? JSON.parse(text) : null } catch { /* not JSON: handled as an error below */ }
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body }
}

/** The token is dead or lacks what we need: every rule on this connection must stop and the workspace must reconnect. */
const CONNECTION_FAULTS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'missing_scope', 'no_permission', 'org_login_required', 'team_access_not_granted', 'invalid_token'])
/** This one channel cannot be posted to (and will not start working by waiting): turn that rule off. */
const CHANNEL_FAULTS = new Set(['channel_not_found', 'is_archived', 'not_in_channel', 'restricted_action', 'access_denied', 'channel_is_archived', 'posting_to_general_channel_denied'])
/** Our message was rejected as malformed: retrying the identical message cannot help, but the rule itself is fine. */
const MESSAGE_FAULTS = new Set(['msg_too_long', 'invalid_blocks', 'invalid_blocks_format', 'invalid_arguments', 'invalid_arg_name', 'invalid_array_arg', 'invalid_charset', 'invalid_form_data', 'invalid_post_type', 'no_text', 'too_many_attachments'])

export type SlackVerdict =
  | { outcome: 'ok' }
  | { outcome: 'retry'; error: string }
  | { outcome: 'permanent'; error: string }
  | { outcome: 'channel_off'; error: string; reason: string }
  | { outcome: 'connection_off'; error: string; reason: string }

export function classifySlack(res: SlackResponse): SlackVerdict {
  if (res.status === 429) return { outcome: 'retry', error: 'Slack rate limit (HTTP 429)' }
  if (res.status >= 500) return { outcome: 'retry', error: `Slack answered HTTP ${res.status}` }
  if (res.body && res.body.ok === true) return { outcome: 'ok' }
  const code = String(res.body?.error || (res.body ? 'unknown_error' : `unreadable answer (HTTP ${res.status})`))
  if (CONNECTION_FAULTS.has(code)) return { outcome: 'connection_off', error: `Slack: ${code}`, reason: `Slack needs to be reconnected (${code}).` }
  if (CHANNEL_FAULTS.has(code)) return { outcome: 'channel_off', error: `Slack: ${code}`, reason: code === 'not_in_channel' ? 'The ScopeGov app is not in that private channel. Invite it, then turn this rule back on.' : `Slack can no longer post to this channel (${code}).` }
  if (MESSAGE_FAULTS.has(code)) return { outcome: 'permanent', error: `Slack rejected the message (${code})` }
  return { outcome: 'retry', error: `Slack: ${code}` } // ratelimited, internal_error, service_unavailable, fatal_error, unknown...
}
