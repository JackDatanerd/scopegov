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

import { Resend } from 'resend'
import { createServiceClient } from '@/lib/supabase/server'

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

// Accounts anonymised by the deletion flow. Mail to them can only bounce, and
// bounces hurt the sending domain's reputation for every workspace.
const DEAD_ADDRESS = /@deleted\.scopegov\.app$/i
const SIMPLE_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

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

export async function sendEmail(payload: EmailPayload, log?: EmailLogContext): Promise<SendResult> {
  const toList = uniqueLower((Array.isArray(payload.to) ? payload.to : [payload.to]).filter(Boolean))
  const deliverableTo = toList.filter(isDeliverableAddress)
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
    .filter(isDeliverableAddress)
    .filter(e => !toKeys.has(e.toLowerCase()))

  const body: Record<string, unknown> = {
    from: payload.from,
    to: deliverableTo,
    subject: payload.subject,
    html: payload.html,
  }
  if (cc.length) body.cc = cc
  if (payload.replyTo && isDeliverableAddress(payload.replyTo)) body.replyTo = payload.replyTo.trim()
  if (payload.attachments?.length) body.attachments = payload.attachments

  let result: SendResult
  try {
    const res: any = await client().emails.send(body as any)
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
      kind: log?.kind, to: deliverableTo.length, subject: payload.subject, error: result.error,
    })
  }
  if (log) await recordEmailLog(log, deliverableTo, cc, payload.subject, result)
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
      subject:      subject.slice(0, 300),
      provider_id:  result.ok ? result.id : null,
      status:       result.ok ? 'sent' : 'failed',
      error:        result.ok ? null : result.error.slice(0, 500),
    })
    if (error) console.error('[email] email_log insert failed:', error.message)
  } catch (e) {
    console.error('[email] email_log insert threw:', e)
  }
}
