// lib/email/resend-inbound.ts
//
// Guardian inbound email via Resend ("Receiving"). Replaces the Postmark inbound webhook.
//
// How Resend delivers inbound mail (different from a one-shot JSON payload):
//   1. Resend POSTs a small, Svix-signed `email.received` event: sender, recipients, subject, ids - NO body.
//   2. We fetch the body + headers:      GET /emails/receiving/{id}?html_format=cid
//   3. We list attachments (signed URLs): GET /emails/receiving/{id}/attachments
//   4. We download each file from its signed `download_url` (valid ~1 hour).
// Because attachments are downloaded by us, they never travel inside a request body, so Vercel's 4.5 MB body
// limit that capped the Postmark route no longer applies.
//
// Plain fetch against the REST API (no SDK): the app's pinned `resend` SDK (4.x) predates the receiving API, and
// pulling in SDK 6 would touch every outbound send for three GET calls. Signature checks reuse the existing
// node:crypto Svix verifier (lib/email/webhook.ts).
//
// ISOLATION: inbound uses its OWN Resend key + webhook secret (RESEND_INBOUND_API_KEY / RESEND_INBOUND_WEBHOOK_SECRET),
// ideally from a separate Resend team. Received mail counts against the same quota as sent mail and the project
// addresses are unauthenticated, so sharing a team with outbound would let spam to a guard address exhaust the quota
// that sends SOWs, invoices and reminders.

import { verifyResendSignature } from './webhook'

const API_BASE = 'https://api.resend.com'
const API_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 30_000

/** Thrown for any failure fetching from Resend. The route answers 500 so Resend redelivers (and the event stays replayable). */
export class InboundFetchError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

// ── Webhook event ────────────────────────────────────────────────────────────

export interface ReceivedEvent {
  emailId: string
  /** Bare sender address from the event (display name is in the fetched headers). */
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  receivedFor: string[]
  subject: string
  /** The event's own timestamp (ms since epoch) or null - used only to tell "not stored yet" from "expired". */
  eventAtMs: number | null
}

const strArray = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** Returns null for anything that is not a well-formed `email.received` event. */
export function parseReceivedEvent(event: any): ReceivedEvent | null {
  if (!event || event.type !== 'email.received') return null
  const d = event.data
  if (!d || typeof d.email_id !== 'string' || !d.email_id) return null
  const created = Date.parse(String(event.created_at || d.created_at || ''))
  return {
    emailId: d.email_id,
    from: typeof d.from === 'string' ? d.from : '',
    to: strArray(d.to), cc: strArray(d.cc), bcc: strArray(d.bcc), receivedFor: strArray(d.received_for),
    subject: typeof d.subject === 'string' ? d.subject : '',
    eventAtMs: Number.isFinite(created) ? created : null,
  }
}

/**
 * Every address the message was delivered for, one string for matchGuardianAddress. `to` first so that a message
 * addressed to project A that also carries a Received `for` clause naming project B still resolves to A.
 * `bcc` and `received_for` matter: a BCC'd guard address is not in `to`.
 */
export function recipientHeader(ev: Pick<ReceivedEvent, 'to' | 'cc' | 'bcc' | 'receivedFor'>): string {
  return [...ev.to, ...ev.cc, ...ev.bcc, ...ev.receivedFor].join(', ')
}

export function verifyInboundSignature(
  rawBody: string,
  headers: { get(name: string): string | null },
  secret: string | undefined,
): boolean {
  if (!secret) return false
  return verifyResendSignature(rawBody, {
    id: headers.get('svix-id'), timestamp: headers.get('svix-timestamp'), signature: headers.get('svix-signature'),
  }, secret)
}

// ── REST calls ───────────────────────────────────────────────────────────────

function apiKey(): string {
  const key = process.env.RESEND_INBOUND_API_KEY
  if (!key) throw new InboundFetchError('RESEND_INBOUND_API_KEY is not set')
  return key
}

async function timedFetch(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try { return await fetch(url, { ...init, signal: ctl.signal }) }
  catch (e) { throw new InboundFetchError(`request failed: ${(e as Error)?.name === 'AbortError' ? 'timeout' : (e as Error)?.message}`) }
  finally { clearTimeout(timer) }
}

async function apiGet(path: string): Promise<any> {
  const res = await timedFetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json' }, cache: 'no-store',
  }, API_TIMEOUT_MS)
  if (!res.ok) throw new InboundFetchError(`Resend ${path.split('?')[0]} -> ${res.status}`, res.status)
  try { return await res.json() } catch { throw new InboundFetchError(`Resend ${path.split('?')[0]} returned invalid JSON`, res.status) }
}

export interface ReceivedEmail {
  text: string
  html: string
  /** Header map as Resend returns it (lower-case keys). */
  headers: Record<string, string>
  /** RFC Message-ID header, for the audit trail. */
  rfcMessageId: string | null
  authentication: InboundAuthentication | null
  attachmentCount: number
}

export async function fetchReceivedEmail(emailId: string): Promise<ReceivedEmail> {
  // html_format=cid: inline images stay as cid: references. The default inlines them as base64 data: URIs, which on a
  // long reply chain can make `html` tens of MB - memory and time we'd spend on text that is stripped anyway.
  const j = await apiGet(`/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`)
  const headers: Record<string, string> = {}
  if (j?.headers && typeof j.headers === 'object') {
    for (const [k, v] of Object.entries(j.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.filter(x => typeof x === 'string').join(', ')
    }
  }
  return {
    text: typeof j?.text === 'string' ? j.text : '',
    html: typeof j?.html === 'string' ? j.html : '',
    headers,
    rfcMessageId: typeof j?.message_id === 'string' && j.message_id ? j.message_id : null,
    authentication: parseAuthentication(j?.authentication),
    attachmentCount: Array.isArray(j?.attachments) ? j.attachments.length : 0,
  }
}

export interface InboundAttachmentFile {
  id: string
  filename: string
  contentType: string
  size: number
  downloadUrl: string
}

export async function listReceivedAttachments(emailId: string): Promise<InboundAttachmentFile[]> {
  const j = await apiGet(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`)
  const rows: any[] = Array.isArray(j?.data) ? j.data : []
  const out: InboundAttachmentFile[] = []
  for (const a of rows) {
    if (!a || typeof a.id !== 'string' || typeof a.download_url !== 'string') continue
    out.push({
      id: a.id,
      filename: typeof a.filename === 'string' ? a.filename : '',
      contentType: typeof a.content_type === 'string' ? a.content_type : '',
      size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0,
      downloadUrl: a.download_url,
    })
  }
  return out
}

/**
 * Download one attachment from its signed URL. Returns null when it is over `maxBytes` (declared or actual) - the
 * caller skips it. Throws InboundFetchError on a transport/HTTP failure after one retry (the URL is valid for an hour).
 * The signed URL is the credential: no Authorization header is sent to it.
 */
export async function downloadReceivedAttachment(file: InboundAttachmentFile, maxBytes: number): Promise<Buffer | null> {
  let url: URL
  try { url = new URL(file.downloadUrl) } catch { throw new InboundFetchError('attachment URL is not a URL') }
  if (url.protocol !== 'https:') throw new InboundFetchError('attachment URL is not https')
  if (file.size > maxBytes) return null

  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await timedFetch(url.toString(), { cache: 'no-store' }, DOWNLOAD_TIMEOUT_MS)
      if (res.status >= 500 || res.status === 429) throw new InboundFetchError(`attachment download -> ${res.status}`, res.status)
      if (!res.ok) throw Object.assign(new InboundFetchError(`attachment download -> ${res.status}`, res.status), { final: true })
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) return null
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.length > maxBytes ? null : buf
    } catch (e) {
      lastErr = e
      if ((e as any)?.final) break
    }
  }
  throw lastErr instanceof Error ? lastErr : new InboundFetchError('attachment download failed')
}

// ── Normalisation ────────────────────────────────────────────────────────────

export type AuthResult = 'pass' | 'fail' | 'gray' | 'processing_failed' | 'unknown'
export interface InboundAuthentication { spf: AuthResult; dkim: AuthResult; dmarc: AuthResult }

const AUTH_VALUES: ReadonlySet<string> = new Set(['pass', 'fail', 'gray', 'processing_failed', 'unknown'])
const authValue = (v: unknown): AuthResult => (typeof v === 'string' && AUTH_VALUES.has(v) ? (v as AuthResult) : 'unknown')

/** SPF/DKIM/DMARC as computed by Resend's receiving server (not forgeable by the sender). null when absent. */
export function parseAuthentication(a: any): InboundAuthentication | null {
  if (!a || typeof a !== 'object') return null
  return { spf: authValue(a.spf), dkim: authValue(a.dkim), dmarc: authValue(a.dmarc) }
}

/**
 * Only an explicit DMARC `fail` disqualifies a sender from being "known". `gray` (no DMARC policy / p=none) and a missing
 * result are not evidence of spoofing and must not demote a genuine client who simply has no DMARC record.
 */
export function senderFailedAuthentication(a: InboundAuthentication | null): boolean {
  return a?.dmarc === 'fail'
}

/** Header map -> the `[{Name, Value}]` list lib/ai/guardian-email.ts (isAutomatedMessage) reads. */
export function headersToList(headers: Record<string, string>): Array<{ Name: string; Value: string }> {
  return Object.entries(headers).map(([Name, Value]) => ({ Name, Value }))
}

/** `Jane <jane@x.com>` -> `jane@x.com`; a bare address is returned as is. */
export function bareAddress(from: string): string {
  const m = String(from || '').match(/<([^>]+)>/)
  return (m ? m[1] : String(from || '')).trim()
}

/**
 * The shape isAutomatedMessage()/senderEmail() read. Those helpers (and their tests) predate the provider swap and
 * take `{ From, FromFull: { Email }, Headers: [{ Name, Value }] }`; this adapter feeds them from a Resend email.
 */
export function toSenderView(ev: Pick<ReceivedEvent, 'from'>, email: Pick<ReceivedEmail, 'headers'>) {
  const displayFrom = email.headers['from'] || ev.from
  return {
    From: displayFrom,
    FromFull: { Email: bareAddress(ev.from || displayFrom) },
    Headers: headersToList(email.headers),
  }
}
