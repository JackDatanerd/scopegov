// lib/integrations/delivery.ts
//
// Drains the integration_deliveries queue. Called once a minute by /api/cron/integration-delivery.
//
// Lifecycle of a delivery row:  pending -> delivering (claimed, attempts+1) -> succeeded
//                                                                          \-> pending (retry, next_attempt_at pushed out)
//                                                                          \-> dead    (attempts exhausted, or 410 Gone)
//                                                                          \-> skipped (subscription gone/off, plan no longer allows it)
//
// Guarantees: at-least-once delivery. A receiver may see the same X-ScopeGov-Delivery id twice (a worker that died
// after the POST but before recording it) and should de-duplicate on it.

import { pinnedPost, type PinnedResponse } from './pinned-request'
import { effectivePlanTier, isWorkspaceLapsed } from '@/lib/billing/plans'
import { decryptSecret } from './crypto'
import { signPayload } from './signing'
import { integrationAllowed, type IntegrationKind } from './plans'
import { loadDocuments, withDocument } from './enrich'
import { classifySlack, slackCall, type SlackCaller } from './slack'
import { buildSlackMessage } from './slack-message'
import { archiveExecutedDocument, type ArchiveInput, type ArchiveOutcome } from './drive-archive'
import { googleCall } from './google'

export const MAX_ATTEMPTS = 8
export const REQUEST_TIMEOUT_MS = 8_000
export const AUTO_DISABLE_AFTER_DEAD = 10
const CONCURRENCY = 5
// Delay before the NEXT attempt, indexed by the attempt that just failed (1-based): 1m, 5m, 15m, 1h, 3h, 6h, 12h.
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720]
const MAX_RETRY_AFTER_SECONDS = 12 * 3600

export type Outcome = 'ok' | 'gone' | 'permanent' | 'retry'

/** What a sender must provide: one POST, no redirect-following, returns the status and any Retry-After. */
export type Sender = (url: string, req: { headers: Record<string, string>; body: string; timeoutMs: number }) => Promise<PinnedResponse>

export function classifyStatus(status: number): Outcome {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 410) return 'gone'
  // A redirect is never followed (see pinned-request.ts), and retrying cannot change the answer: the URL must be fixed.
  if (status >= 300 && status < 400) return 'permanent'
  return 'retry'
}

/** Milliseconds until the next attempt after `attempts` failed ones; a receiver's Retry-After can only lengthen it. */
export function retryDelayMs(attempts: number, retryAfterSeconds?: number | null): number {
  const base = BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1] * 60_000
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.max(base, Math.min(retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) * 1000)
  return base
}

export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null
  const n = Number(header)
  if (Number.isFinite(n)) return n >= 0 ? n : null
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - now) / 1000))
}

export function buildEnvelope(event: any, context: { project?: any; client?: any; data?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    id: event.id,
    type: event.event_type,
    created_at: event.created_at,
    workspace_id: event.workspace_id,
    project_id: event.project_id || null,
    entity: event.entity_type || event.entity_id ? { type: event.entity_type || null, id: event.entity_id || null } : null,
    // Names and status only — never contract values, emails or phone numbers (those sit behind VIEW_FINANCIALS / VIEW_CLIENT_DATA).
    project: context.project ? { id: context.project.id, name: context.project.name, status: context.project.status, currency: context.project.currency ?? null } : null,
    client: context.client ? { id: context.client.id, name: context.client.name } : null,
    data: context.data ?? event.data ?? {},
  }
}

const trim = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s)

export interface ProcessResult { claimed: number; succeeded: number; retried: number; dead: number; skipped: number }

export async function processDeliveries(
  service: any,
  opts: { limit?: number; now?: () => number; send?: Sender; slack?: SlackCaller; drive?: (i: ArchiveInput) => Promise<ArchiveOutcome> } = {},
): Promise<ProcessResult> {
  const send: Sender = opts.send || ((u, r) => pinnedPost(u, r))
  const slack: SlackCaller = opts.slack || slackCall
  const drive = opts.drive || ((i: ArchiveInput) => archiveExecutedDocument(i))
  const nowMs = opts.now || Date.now
  const result: ProcessResult = { claimed: 0, succeeded: 0, retried: 0, dead: 0, skipped: 0 }

  const { data: claimed, error } = await service.rpc('claim_integration_deliveries', { p_limit: opts.limit ?? 50, p_stale_seconds: 300 })
  if (error) throw new Error(`claim failed: ${error.message}`)
  const rows: any[] = claimed || []
  result.claimed = rows.length
  if (!rows.length) return result

  const ids = (k: string) => Array.from(new Set(rows.map(r => r[k])))
  const [subsRes, eventsRes, wsRes] = await Promise.all([
    service.from('integration_subscriptions').select('id, workspace_id, kind, target_url, secret_enc, active, consecutive_failures, connection_id, config').in('id', ids('subscription_id')),
    service.from('integration_events').select('id, workspace_id, event_type, entity_type, entity_id, project_id, data, created_at').in('id', ids('event_id')),
    service.from('workspaces').select('id, plan_tier, trial_ends_at, lapsed_at, deleted_at').in('id', ids('workspace_id')),
  ])
  for (const r of [subsRes, eventsRes, wsRes]) if (r.error) throw new Error(`lookup failed: ${r.error.message}`)
  // Project + client NAMES for the payload, looked up now (only subscribed workspaces ever reach here). Best effort: a
  // failed lookup sends the event without them rather than failing or delaying it.
  const projectIds = Array.from(new Set((eventsRes.data || []).map((e: any) => e.project_id).filter(Boolean)))
  const projects = new Map<string, any>()
  if (projectIds.length) {
    const { data: prows, error: perr } = await service.from('projects').select('id, name, status, currency, client_id, clients(id, name)').in('id', projectIds)
    if (perr) console.error('[integrations] project context lookup failed (sending without it):', perr.message)
    for (const p of prows || []) projects.set(p.id, p)
  }
  // Document details (number, status, amounts, dates) for the document each event refers to — see enrich.ts.
  const documents = await loadDocuments(service, eventsRes.data || [], pid => (pid ? projects.get(pid)?.currency ?? null : null))
  // Slack rules post with their connection's token: load those connections (one query) alongside.
  const connectionIds = Array.from(new Set((subsRes.data || []).filter((s: any) => (s.kind === 'slack' || s.kind === 'google_drive') && s.connection_id).map((s: any) => s.connection_id)))
  const connections = new Map<string, any>()
  if (connectionIds.length) {
    const { data: crows, error: cerr } = await service.from('integration_connections').select('id, workspace_id, status, credentials_enc').in('id', connectionIds)
    if (cerr) throw new Error(`lookup failed: ${cerr.message}`)
    for (const c of crows || []) connections.set(c.id, c)
  }
  const subs = new Map<string, any>((subsRes.data || []).map((s: any) => [s.id, s]))
  const events = new Map<string, any>((eventsRes.data || []).map((e: any) => [e.id, e]))
  const workspaces = new Map<string, any>((wsRes.data || []).map((w: any) => [w.id, w]))

  // Every write is conditional on the row still being OUR claim, so a stale reclaim by another worker is never clobbered.
  const finish = async (row: any, patch: Record<string, unknown>) => {
    const { error: e } = await service.from('integration_deliveries').update(patch)
      .eq('id', row.id).eq('status', 'delivering').eq('attempts', row.attempts)
    if (e) console.error('[integrations] could not record delivery outcome:', e.message)
  }
  const skip = async (row: any, reason: string) => { result.skipped++; await finish(row, { status: 'skipped', last_error: reason, claimed_at: null }) }

  const handle = async (row: any) => {
    const sub = subs.get(row.subscription_id)
    const event = events.get(row.event_id)
    const ws = workspaces.get(row.workspace_id)
    if (!sub || !sub.active) return skip(row, 'subscription is off or deleted')
    if (!event) return skip(row, 'event no longer exists')
    if (!ws || ws.deleted_at) return skip(row, 'workspace is deleted or suspended')
    const tier = effectivePlanTier(ws.plan_tier, ws.trial_ends_at, nowMs())
    const kind: IntegrationKind = sub.kind === 'zapier' ? 'zapier' : sub.kind === 'slack' ? 'slack' : sub.kind === 'google_drive' ? 'google_drive' : 'webhook'
    if (!integrationAllowed(kind, tier, isWorkspaceLapsed(ws.plan_tier, ws.trial_ends_at, ws.lapsed_at, nowMs())))
      return skip(row, 'the workspace plan does not include this integration')

    const proj = event.project_id ? projects.get(event.project_id) : null
    const envelope = buildEnvelope(event, { project: proj, client: proj?.clients, data: withDocument(event, documents) })
    if (sub.kind === 'slack') return handleSlack(row, sub, envelope)
    if (sub.kind === 'google_drive') return handleDrive(row, sub, event, proj)

    let secret: string
    try { secret = decryptSecret(sub.secret_enc, `${sub.workspace_id}:${sub.id}`) }
    catch (e: any) {
      // A configuration fault (key missing / rotated away), not the receiver's: retrying cannot fix it.
      result.dead++
      return finish(row, { status: 'dead', last_error: trim(`signing secret unreadable: ${e?.message || e}`), claimed_at: null })
    }

    const body = JSON.stringify(envelope)
    const ts = Math.floor(nowMs() / 1000)
    let status = 0, errorText: string | null = null, retryAfter: number | null = null
    try {
      const res = await send(sub.target_url, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ScopeGov-Webhooks/1',
          'X-ScopeGov-Event': event.event_type,
          'X-ScopeGov-Delivery': row.id,
          'X-ScopeGov-Attempt': String(row.attempts),
          'X-ScopeGov-Timestamp': String(ts),
          'X-ScopeGov-Signature': signPayload(secret, ts, body),
        },
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
      status = res.status
      retryAfter = parseRetryAfter(res.retryAfter, nowMs())
    } catch (e: any) {
      errorText = e?.name === 'TimeoutError' ? String(e.message) : String(e?.message || e)
    }
    return settle({ row, sub, outcome: status ? classifyStatus(status) : 'retry', status, errorText, retryAfter })
  }

  /**
   * Record what happened to one delivery and keep the subscription's health in step. Shared by every transport so a
   * webhook, a Zap and a Slack rule retry, die and switch off by exactly the same rules.
   */
  const settle = async (a: { row: any; sub: any; outcome: Outcome; status: number; errorText: string | null; retryAfter: number | null; disableReason?: string; connectionFault?: boolean; noStreak?: boolean }) => {
    const { row, sub, outcome, status, errorText, retryAfter } = a
    const at = new Date(nowMs()).toISOString()

    if (outcome === 'ok') {
      result.succeeded++
      await finish(row, { status: 'succeeded', last_status: status, last_error: null, delivered_at: at, claimed_at: null })
      if (sub.consecutive_failures) await service.from('integration_subscriptions').update({ consecutive_failures: 0, last_success_at: at }).eq('id', sub.id)
      else await service.from('integration_subscriptions').update({ last_success_at: at }).eq('id', sub.id)
      return
    }

    const msg = trim(errorText || (outcome === 'permanent' ? `receiver answered HTTP ${status} (a redirect); update the URL to its final address` : `receiver answered HTTP ${status}`))
    if (outcome === 'gone' || outcome === 'permanent' || row.attempts >= MAX_ATTEMPTS) {
      result.dead++
      await finish(row, { status: 'dead', last_status: status || null, last_error: msg, claimed_at: null })
      // A fault in ONE document (e.g. no frozen PDF for an old contract) says nothing about the destination's health, so it
      // must not count toward switching the whole rule off.
      if (a.noStreak && outcome === 'permanent') return
      const failures = (sub.consecutive_failures || 0) + 1
      const disable = outcome === 'gone' || failures >= AUTO_DISABLE_AFTER_DEAD
      await service.from('integration_subscriptions').update({
        consecutive_failures: failures, last_failure_at: at,
        ...(disable ? { active: false, disabled_reason: outcome === 'gone' ? (a.disableReason ?? 'The receiver answered 410 Gone (it asked us to stop).') : `Turned off after ${failures} deliveries in a row failed.` } : {}),
      }).eq('id', sub.id)
      if (a.connectionFault && sub.connection_id) {
        // The Slack token is dead: stop every rule on this connection and flag it, so the settings page says "reconnect".
        await service.from('integration_connections').update({ status: 'error', last_error: msg, last_error_at: at, updated_at: at }).eq('id', sub.connection_id)
        await service.from('integration_subscriptions').update({ active: false, disabled_reason: a.disableReason ?? 'Slack needs to be reconnected.' }).eq('connection_id', sub.connection_id)
      }
      return
    }

    result.retried++
    await finish(row, {
      status: 'pending', last_status: status || null, last_error: msg, claimed_at: null,
      next_attempt_at: new Date(nowMs() + retryDelayMs(row.attempts, retryAfter)).toISOString(),
    })
    await service.from('integration_subscriptions').update({ last_failure_at: at }).eq('id', sub.id)
  }

  const handleDrive = async (row: any, sub: any, event: any, proj: any) => {
    const conn = connections.get(sub.connection_id)
    if (!conn) return skip(row, 'Google Drive is not connected')
    if (conn.status !== 'active') return skip(row, 'Google Drive needs to be reconnected')
    let out: ArchiveOutcome
    try {
      out = await drive({ service, connection: conn, event, project: proj, call: googleCall })
    } catch (e: any) {
      return settle({ row, sub, outcome: 'retry', status: 0, errorText: `Drive archive failed: ${e?.message || e}`, retryAfter: null })
    }
    const v = out.verdict
    switch (v.outcome) {
      case 'ok': return settle({ row, sub, outcome: 'ok', status: 200, errorText: null, retryAfter: null })
      case 'retry': return settle({ row, sub, outcome: 'retry', status: 0, errorText: v.error, retryAfter: null })
      case 'permanent': return settle({ row, sub, outcome: 'permanent', status: 0, errorText: v.error, retryAfter: null, noStreak: true })
      case 'rule_off': return settle({ row, sub, outcome: 'gone', status: 0, errorText: v.error, retryAfter: null, disableReason: v.reason })
      case 'connection_off': return settle({ row, sub, outcome: 'gone', status: 0, errorText: v.error, retryAfter: null, disableReason: v.reason, connectionFault: true })
      case 'folder_gone': return settle({ row, sub, outcome: 'retry', status: 0, errorText: v.error, retryAfter: null })
    }
  }

  const handleSlack = async (row: any, sub: any, envelope: Record<string, unknown>) => {
    const conn = connections.get(sub.connection_id)
    if (!conn) return skip(row, 'Slack is not connected')
    if (conn.status !== 'active') return skip(row, 'Slack needs to be reconnected')
    const channel = sub.config?.channel_id
    let token: string
    try { token = JSON.parse(decryptSecret(conn.credentials_enc, `${conn.workspace_id}:${conn.id}`)).access_token } catch (e: any) {
      result.dead++
      return finish(row, { status: 'dead', last_error: trim(`Slack token unreadable: ${e?.message || e}`), claimed_at: null })
    }
    if (!token || !channel) { result.dead++; return finish(row, { status: 'dead', last_error: 'Slack rule has no token or channel', claimed_at: null }) }

    const message = buildSlackMessage(envelope, { appUrl: process.env.NEXT_PUBLIC_APP_URL })
    let res
    try {
      res = await slack('chat.postMessage', token, { channel, text: message.text, blocks: message.blocks, unfurl_links: false, unfurl_media: false })
    } catch (e: any) {
      const text = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `Slack did not answer within ${REQUEST_TIMEOUT_MS / 1000}s` : String(e?.message || e)
      return settle({ row, sub, outcome: 'retry', status: 0, errorText: text, retryAfter: null })
    }
    const verdict = classifySlack(res)
    const retryAfter = parseRetryAfter(res.retryAfter, nowMs())
    switch (verdict.outcome) {
      case 'ok': return settle({ row, sub, outcome: 'ok', status: res.status, errorText: null, retryAfter: null })
      case 'retry': return settle({ row, sub, outcome: 'retry', status: res.status, errorText: verdict.error, retryAfter })
      case 'permanent': return settle({ row, sub, outcome: 'permanent', status: res.status, errorText: verdict.error, retryAfter: null })
      case 'channel_off': return settle({ row, sub, outcome: 'gone', status: res.status, errorText: verdict.error, retryAfter: null, disableReason: verdict.reason })
      case 'connection_off': return settle({ row, sub, outcome: 'gone', status: res.status, errorText: verdict.error, retryAfter: null, disableReason: verdict.reason, connectionFault: true })
    }
  }

  // Small fixed pool: one slow receiver must not hold up the rest of the batch.
  let next = 0
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++]
      try { await handle(row) } catch (e) { console.error('[integrations] delivery handler threw:', e) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker))
  return result
}
