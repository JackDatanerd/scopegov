// lib/email/send.ts
//
// The single place an email leaves the app.
//
// FIX (Notifications & email fix round — flagship finding): the Resend SDK
// (locked 4.8.0) NEVER throws for an API failure or a network failure — it
// resolves `{ data: null, error }`. Every one of the ~47 send sites wrapped
// the call in try/catch as if it did, so a rejected send (unverified
// domain, invalid address, 429, 5xx, bad API key) was indistinguishable
// from success: a SOW/CO/invoice was marked sent although nothing was
// delivered, reminder routes armed their 24h cooldown and returned ok, and
// the ops-alert/guardian-health "only consume the cooldown after a
// successful send" fixes could never trigger. (Reproduced against the real
// SDK with a mock server: 422 and a refused connection both resolve.)
//
// sendEmail() turns that into an explicit result the caller can act on. It
// never throws.

import { EMAIL_RE } from '@/lib/utils/client-input'
import { Resend } from 'resend'
import { createServiceClient } from '@/lib/supabase/server'
import { truncateText } from '@/lib/utils/sanitize'

export interface EmailPayload {
  from: string
  to: string | string[]
  cc?: string[]
  subject: string
  html: string
  replyTo?: string | null
  attachments?: Array<{ filename: string; content: string }>
}

/** When present, the send is recorded in email_log so bounces can be traced. */
export interface EmailLogContext {
  workspaceId: string
  /** e.g. 'sow.send', 'invoice.reminder' */
  kind: string
  entityType?: string
  entityId?: string
  projectId?: string
  actorId?: string | null
}

export type SendResult =
  | { ok: true; id: string | null; skipped?: boolean }
  | { ok: false; error: string }

let _resend: Resend | null = null
function client(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}
/** Test seam. */
export function __setResendForTests(r: Resend | null) { _resend = r }

// Pauses before each retry of a rate-limited send (so at most 2 retries, ~2s added to the worst case).
let rateLimitRetryDelaysMs: number[] = [600, 1500]
/** Test seam. */
export function __setRateLimitRetryDelaysForTests(delays: number[]) { rateLimitRetryDelaysMs = delays }

// Accounts anonymised by the deletion flow. Mail to them can only bounce, and
// bounces hurt the sending domain's reputation for every workspace.
const DEAD_ADDRESS = /@deleted\.scopegov\.app$/i
const SIMPLE_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

// Settings independent pass 14: the Reply-To header (workspace reply_to_email) is validated with the strict address
// pattern the client forms use. SIMPLE_EMAIL only excludes whitespace and a few specials, so a NUL byte, a lone
// surrogate, a zero-width character, `a@x..com`, a trailing dot / `)` / curly quote all passed, were stored and then
// went out on every client-facing email as a malformed Reply-To.
export function isValidReplyTo(email: string | null | undefined): email is string {
  return isDeliverableAddress(email) && EMAIL_RE.test(email.trim())
}

/**
 * Strict check applied to every address that actually goes into a request. Resend rejects the WHOLE message (422) if any
 * single address is malformed, and addresses already stored (legacy client rows accepted as-is) can still be shapes such as
 * `a@b..co` or `a..b@c.co` that the loose SIMPLE_EMAIL pattern lets through.
 */
function isSendableAddress(email: string): boolean {
  return isDeliverableAddress(email) && EMAIL_RE.test(email.trim())
}

export function isDeliverableAddress(email: string | null | undefined): email is string {
  return !!email && SIMPLE_EMAIL.test(email.trim()) && !DEAD_ADDRESS.test(email.trim())
}

function uniqueLower(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of list) {
    const k = e.trim().toLowerCase()
    if (!seen.has(k)) { seen.add(k); out.push(e.trim()) }
  }
  return out
}

/**
 * A Subject is a single header line. Titles and names reach it from user-entered text (an invoice title is stored with
 * only a trim), so CR/LF, other control characters and Unicode line separators are replaced with a space and runs of
 * whitespace collapsed; the provider would otherwise reject or fold the message.
 */
export function cleanSubject(subject: string | null | undefined): string {
  const s = String(subject ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    // Bidi controls and invisible format characters (\p{Cf}) can reorder or hide text in a Subject. ZWNJ / ZWJ are kept:
    // they are real characters in Persian / Urdu / Indic text and emoji sequences (same rule as sanitizeDisplayName).
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s || 'Notification from ScopeGov'
}

export async function sendEmail(payload: EmailPayload, log?: EmailLogContext): Promise<SendResult> {
  const toList = uniqueLower((Array.isArray(payload.to) ? payload.to : [payload.to]).filter(Boolean))
  const deliverableTo = toList.filter(isSendableAddress)
  if (deliverableTo.length === 0) {
    // Nothing legitimate to send to. A dead/invalid *primary* recipient is an
    // error for a single-recipient send (the caller should know), but a list
    // that only contained anonymised accounts is simply skipped.
    const onlyDead = toList.length > 0 && toList.every(e => DEAD_ADDRESS.test(e))
    if (onlyDead || toList.length === 0) return { ok: true, id: null, skipped: true }
    return { ok: false, error: `Invalid recipient address: ${toList[0]}` }
  }

  // A bad CC must not sink the whole message — Resend rejects the entire
  // request (422) if any single address is malformed.
  const toKeys = new Set(deliverableTo.map(e => e.toLowerCase()))
  const cc = uniqueLower(payload.cc || [])
    .filter(isSendableAddress)
    .filter(e => !toKeys.has(e.toLowerCase()))

  const subject = cleanSubject(payload.subject)
  const body: Record<string, unknown> = {
    from: payload.from,
    to: deliverableTo,
    subject,
    html: payload.html,
  }
  if (cc.length) body.cc = cc
  if (payload.replyTo && isValidReplyTo(payload.replyTo)) body.replyTo = payload.replyTo.trim()
  if (payload.attachments?.length) body.attachments = payload.attachments
  // Marks a send that has an email_log row, so the delivery webhook knows an event that arrives before the row is
  // written is worth retrying (see app/api/webhooks/resend). Untracked mail carries no tag and is ignored right away.
  if (log) body.tags = [{ name: 'tracked', value: '1' }]

  let result: SendResult
  try {
    // FIX (Notifications & email pass 18 — B4): a provider rate limit (429 `rate_limit_exceeded`) was treated like any
    // other rejection, so a cron that sends one email per row in a loop lost every message past the per-second cap
    // (stall / expiry / overdue notices are not retried later). A 429 means the message was NOT accepted, so sending
    // it again after a short pause cannot duplicate it. Quota errors (daily / monthly) also arrive as 429 but will
    // not clear in seconds, so only `rate_limit_exceeded` is retried.
    let res: any
    for (let attempt = 0; ; attempt++) {
      res = await client().emails.send(body as any)
      const limited = res?.error?.name === 'rate_limit_exceeded'
      if (!limited || attempt >= rateLimitRetryDelaysMs.length) break
      await new Promise(resolve => setTimeout(resolve, rateLimitRetryDelaysMs[attempt]))
    }
    if (res?.error) {
      result = { ok: false, error: String(res.error.message || res.error.name || 'Email provider rejected the message') }
    } else {
      result = { ok: true, id: res?.data?.id ?? null }
    }
  } catch (e: any) {
    // Only reachable for local failures (e.g. RESEND_API_KEY unset makes the
    // SDK constructor throw) — the SDK itself never throws for API errors.
    result = { ok: false, error: String(e?.message || e || 'Email send failed') }
  }

  if (!result.ok) {
    console.error('[email] send failed', {
      kind: log?.kind, to: deliverableTo.length, subject, error: result.error,
    })
  }
  if (log) await recordEmailLog(log, deliverableTo, cc, subject, result)
  return result
}

async function recordEmailLog(
  ctx: EmailLogContext, to: string[], cc: string[], subject: string, result: SendResult,
): Promise<void> {
  try {
    const service: any = createServiceClient()
    const { error } = await service.from('email_log').insert({
      workspace_id: ctx.workspaceId,
      kind:         ctx.kind,
      entity_type:  ctx.entityType ?? null,
      entity_id:    ctx.entityId ?? null,
      project_id:   ctx.projectId ?? null,
      actor_id:     ctx.actorId ?? null,
      to_emails:    to,
      cc_emails:    cc,
      // truncateText never strands half an emoji: a lone surrogate makes Postgres reject the whole row, losing bounce tracking.
      subject:      truncateText(subject, 300),
      provider_id:  result.ok ? result.id : null,
      status:       result.ok ? 'sent' : 'failed',
      error:        result.ok ? null : truncateText(result.error, 500),
    })
    if (error) console.error('[email] email_log insert failed:', error.message)
  } catch (e) {
    console.error('[email] email_log insert threw:', e)
  }
}
