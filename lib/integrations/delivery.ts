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
  opts: { limit?: number; now?: () => number; send?: Sender } = {},
): Promise<ProcessResult> {
  const send: Sender = opts.send || ((u, r) => pinnedPost(u, r))
  const nowMs = opts.now || Date.now
  const result: ProcessResult = { claimed: 0, succeeded: 0, retried: 0, dead: 0, skipped: 0 }

  const { data: claimed, error } = await service.rpc('claim_integration_deliveries', { p_limit: opts.limit ?? 50, p_stale_seconds: 300 })
  if (error) throw new Error(`claim failed: ${error.message}`)
  const rows: any[] = claimed || []
  result.claimed = rows.length
  if (!rows.length) return result

  const ids = (k: string) => Array.from(new Set(rows.map(r => r[k])))
  const [subsRes, eventsRes, wsRes] = await Promise.all([
    service.from('integration_subscriptions').select('id, workspace_id, kind, target_url, secret_enc, active, consecutive_failures').in('id', ids('subscription_id')),
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
    const kind: IntegrationKind = sub.kind === 'zapier' ? 'zapier' : sub.kind === 'slack' ? 'slack' : 'webhook'
    if (!integrationAllowed(kind, tier, isWorkspaceLapsed(ws.plan_tier, ws.trial_ends_at, ws.lapsed_at, nowMs())))
      return skip(row, 'the workspace plan does not include this integration')

    let secret: string
    try { secret = decryptSecret(sub.secret_enc, `${sub.workspace_id}:${sub.id}`) }
    catch (e: any) {
      // A configuration fault (key missing / rotated away), not the receiver's: retrying cannot fix it.
      result.dead++
      return finish(row, { status: 'dead', last_error: trim(`signing secret unreadable: ${e?.message || e}`), claimed_at: null })
    }

    const proj = event.project_id ? projects.get(event.project_id) : null
    const body = JSON.stringify(buildEnvelope(event, { project: proj, client: proj?.clients, data: withDocument(event, documents) }))
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

    const outcome: Outcome = status ? classifyStatus(status) : 'retry'
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
      const failures = (sub.consecutive_failures || 0) + 1
      const disable = outcome === 'gone' || failures >= AUTO_DISABLE_AFTER_DEAD
      await service.from('integration_subscriptions').update({
        consecutive_failures: failures, last_failure_at: at,
        ...(disable ? { active: false, disabled_reason: outcome === 'gone' ? 'The receiver answered 410 Gone (it asked us to stop).' : `Turned off after ${failures} deliveries in a row failed.` } : {}),
      }).eq('id', sub.id)
      return
    }

    result.retried++
    await finish(row, {
      status: 'pending', last_status: status || null, last_error: msg, claimed_at: null,
      next_attempt_at: new Date(nowMs() + retryDelayMs(row.attempts, retryAfter)).toISOString(),
    })
    await service.from('integration_subscriptions').update({ last_failure_at: at }).eq('id', sub.id)
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
