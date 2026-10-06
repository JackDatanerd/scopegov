export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import {
  verifyResendSignature, nextEmailStatus, classifyEmailKind, bounceAlertBody, failureKindForEvent,
  suppressedAlertBody, failedAlertBody, type EmailFailureKind,
} from '@/lib/email/webhook'
import { notifyUsers, notifyMembersWithPermission } from '@/lib/utils/notify'
import type { Permission } from '@/lib/supabase/types'
import { escapeLike, sameEmail } from '@/lib/utils/escape-like'

// Resend delivery webhook (configure in the Resend dashboard → Webhooks → this URL, events
// email.delivered / email.delivery_delayed / email.bounced / email.complained / email.failed / email.suppressed, and
// set RESEND_WEBHOOK_SECRET to the signing secret it shows).
//
// FEATURE (Notifications & email fix round): a client's mail server rejecting a SOW, invoice or
// reminder was invisible — the send "succeeded" at Resend's edge and the bounce arrived minutes later
// to nobody. Tracked sends (email_log) are now matched by Resend's email id, their status follows the
// provider's, and a bounce or spam complaint raises an in-app alert for the person who sent it.

const DOC_BY_KIND: Record<string, { prefix: string; permission: Permission; label: string }> = {
  sow:     { prefix: 'sow',     permission: 'SEND_SOW',          label: 'Statement of Work' },
  co:      { prefix: 'co',      permission: 'SEND_CHANGE_ORDERS', label: 'change order' },
  invoice: { prefix: 'invoice', permission: 'VIEW_FINANCIALS',   label: 'invoice' },
}

export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    console.error('[resend-webhook] RESEND_WEBHOOK_SECRET is not set — refusing to process')
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
  }

  // The signature covers the exact bytes, so read the raw text (never re-serialised JSON).
  const rawBody = await request.text()
  const ok = verifyResendSignature(rawBody, {
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
  }, secret)
  if (!ok) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })

  let event: any
  try { event = JSON.parse(rawBody) } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const type: string = event?.type || ''
  const emailId: string | undefined = event?.data?.email_id
  if (!emailId) return NextResponse.json({ ok: true, ignored: true })
  // Resend emits one event PER RECIPIENT, and `data.to` carries only the address that event is about (a CC's
  // bounce arrives with the CC's address). Reading the log row's first address instead blamed the client's
  // primary address for a bounced CC.
  const impacted = firstAddress(event?.data?.to)

  try {
    const service = createServiceClient() as any
    const { data: row, error } = await service
      .from('email_log')
      .select('id, workspace_id, kind, entity_type, entity_id, project_id, actor_id, to_emails, status, created_at')
      .eq('provider_id', emailId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!row) {
      // Most internal mail (flag alerts, approvals, stall notices) is sent without an email_log row, and Resend still
      // reports on it. Retrying those for two minutes only produced failed deliveries in the Resend dashboard, so a
      // success event is retried only when the email was sent with the `tracked` tag (sendEmail adds it whenever it
      // writes a log row) — see isTrackedSend. That holds for failure events too: only a tracked send can have a row to
      // alert from, so retrying a bounce of untracked mail (503s, failed deliveries in the Resend dashboard) bought nothing.
      const mightBeLogged = isTrackedSend(event)
      // The log row is written right AFTER the send returns, so an event can beat it. Fail (Resend retries after a
      // few seconds) while the event is fresh; an old event for an email we never logged is simply not ours.
      if (mightBeLogged && eventAgeMs(event) < UNLOGGED_RETRY_WINDOW_MS) return NextResponse.json({ error: 'Email not logged yet' }, { status: 503 })
      return NextResponse.json({ ok: true, untracked: true })
    }
    const address = impacted || firstAddress(row.to_emails)

    const next = nextEmailStatus(row.status, type)
    if (!next) {
      // The message-level status did not advance (an earlier event already moved it past this one) — the
      // per-address effects still have to run, see applyAddressEffects.
      await applyAddressEffects(service, row, type, address)
      return NextResponse.json({ ok: true, unchanged: true })
    }

    // Guarded on the status we read, so a concurrent/retried delivery of the same event is a no-op
    // and — importantly — can't raise the alert twice.
    const { data: updated, error: upErr } = await service
      .from('email_log').update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', row.status).select('id')
    if (upErr) throw new Error(upErr.message)
    if (!updated || updated.length === 0) {
      // FIX (Notifications & email independent pass 5): lost the status race. Resend emits one event PER RECIPIENT and
      // delivers them concurrently, so a CC's bounce routinely races the client's own delivered/bounced event: both read
      // the same status, one wins this guarded update, and the loser used to answer 200 "unchanged" having done
      // NOTHING — its recipient's bounce alert and client-record marker (or its delivery clearing a stale marker) were
      // lost for good, because a 200 is never retried. The guard only protects the MESSAGE-level status (and the
      // once-only alert that goes with a status transition); everything per-address runs exactly as in the
      // "did not advance" branch above (the alert is deduplicated, so a concurrent redelivery cannot double it).
      await applyAddressEffects(service, row, type, address)
      return NextResponse.json({ ok: true, unchanged: true })
    }

    const failure = failureKindForEvent(type)
    if (failure) {
      const alerted = await alertSender(service, row, failure, address)
      if (!alerted) {
        // The status already moved, so a retry would see "unchanged" and the alert would be lost for good. Put the
        // status back (guarded on what we wrote) and fail, so Resend redelivers the event and the alert is retried.
        await service.from('email_log').update({ status: row.status }).eq('id', row.id).eq('status', next)
        throw new Error('bounce alert could not be written')
      }
    }
    await trackClientEmailHealth(service, row, healthStatusFor(failure, next), address)
    return NextResponse.json({ ok: true, status: next })
  } catch (err) {
    console.error('[resend-webhook] processing failed:', err)
    // 500 → Resend retries; the guarded update above makes the retry safe.
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}

/**
 * Per-ADDRESS effects of a webhook event, for the cases where the message-level status did not move for THIS event
 * (it had already advanced past it, or a concurrent event for another recipient won the status update).
 *   • delivered → the address works: clear its stale bounce marker (idempotent, address-scoped).
 *   • bounced / complained → alert the sender (deduplicated, so a redelivered or concurrent copy cannot raise it twice)
 *     and mark the client record. A failed alert throws, so the webhook answers 500 and Resend retries.
 */
async function applyAddressEffects(service: any, row: any, type: string, address: string) {
  if (type === 'email.delivered') await trackClientEmailHealth(service, row, 'delivered', address)
  // FIX (Notifications & email independent pass, bug 1): Resend sends one bounce/complaint event PER RECIPIENT, but the
  // message-level status only moves forward. Once one recipient's bounce had moved it to 'bounced', every later bounce of
  // the same email (a CC first, then the client's own address — the normal shape of a SOW, CO or invoice) came back as
  // "not an advance", so that recipient raised no alert and never marked the client record. The alert and the marker are
  // per address, so they run regardless of whether the message status moved; the alert is deduplicated so a redelivered
  // event cannot raise it twice.
  const failure = failureKindForEvent(type)
  if (failure) {
    const alerted = await alertSender(service, row, failure, address, { dedupe: true })
    if (!alerted) throw new Error('bounce alert could not be written') // → 500, Resend retries
    await trackClientEmailHealth(service, row, healthStatusFor(failure, 'failed'), address)
  }
}

/**
 * What the client-record marker should hear about. A suppressed address is one that already bounced or complained
 * (that is the only way onto the suppression list), so it keeps the red marker as a plain bounce; a provider-side
 * `failed` says nothing about the address and leaves the record alone.
 */
function healthStatusFor(failure: EmailFailureKind | null, fallback: string): string {
  if (failure === 'suppressed') return 'bounced'
  if (failure === 'failed') return 'failed'
  return failure ?? fallback
}

const UNLOGGED_RETRY_WINDOW_MS = 2 * 60 * 1000

function firstAddress(v: unknown): string {
  const first = Array.isArray(v) ? v[0] : v
  return typeof first === 'string' ? first.trim().toLowerCase() : ''
}

/** sendEmail tags every send it logs with tracked=1; Resend echoes the tags back on each event. */
function isTrackedSend(event: any): boolean {
  const tags = event?.data?.tags
  if (Array.isArray(tags)) return tags.some((t: any) => t?.name === 'tracked' && String(t?.value) === '1')
  return !!tags && typeof tags === 'object' && String((tags as any).tracked) === '1'
}

function eventAgeMs(event: any): number {
  const t = Date.parse(event?.created_at || event?.data?.created_at || '')
  return Number.isFinite(t) ? Date.now() - t : Infinity
}

/** Resolves true when the alert was written (or no one was eligible to receive it). */
async function alertSender(
  service: any, row: any, status: EmailFailureKind, address: string, opts: { dedupe?: boolean } = {},
): Promise<boolean> {
  const { docKind, role } = classifyEmailKind(row.kind)
  const doc = DOC_BY_KIND[docKind]
  const to = address || (row.to_emails || [])[0] || 'the client'
  const what = doc ? doc.label : 'email'

  const title = status === 'bounced' ? `Email to ${to} bounced`
    : status === 'complained' ? `${to} marked your email as spam`
    : status === 'suppressed' ? `Email to ${to} was not sent`
    : `Email to ${to} could not be sent`
  const body = status === 'bounced' ? bounceAlertBody(role, what)
    : status === 'complained' ? `Your ${what} email was reported as spam. Avoid further emails to this address until you have spoken to them.`
    : status === 'suppressed' ? suppressedAlertBody(what)
    : failedAlertBody(what)

  const shared = {
    workspaceId: row.workspace_id,
    // Mandatory: no eventType, so no preference can silence a delivery failure.
    title, body,
    entityType: row.project_id ? 'project' : undefined,
    entityId: row.project_id || undefined,
    projectId: row.project_id || undefined,
  }
  const type = doc ? `${doc.prefix}_email_${status}` : `email_${status}`

  // One alert per (failure kind, address) PER EMAIL. The claim lives on the email_log row (migration 149), so an alert
  // raised for a different email to the same address can never be mistaken for this one. If the migration is not
  // applied yet the RPC is missing: fall back to looking for an alert raised after this email was logged.
  const key = `${status}:${address}`
  const claim = await claimAlert(service, row.id, key)
  if (claim === 'already') return true
  if (claim === 'unavailable' && opts.dedupe) {
    let q = service.from('notifications').select('id')
      .eq('workspace_id', row.workspace_id).eq('type', type).eq('title', title)
    if (row.created_at) q = q.gte('created_at', row.created_at)
    const { data: existing, error } = await q.limit(1)
    if (error) { console.error('[resend-webhook] could not check for an existing alert:', error.message); return false }
    if (existing && existing.length > 0) return true
  }

  // The person who triggered the send is the one who can fix it; fall back to whoever manages that
  // kind of document (e.g. an automatic send after approval has no single actor).
  let written = false
  if (row.actor_id) {
    const r = await notifyUsers(service, { ...shared, type, recipientIds: [row.actor_id] })
    if (r.recipients.length > 0) written = r.inserted
    else written = await notifyMembersWithPermission(service, {
      ...shared, type, permission: doc?.permission || 'MANAGE_WORKSPACE_SETTINGS', eventType: '',
    })
  } else {
    written = await notifyMembersWithPermission(service, {
      ...shared, type, permission: doc?.permission || 'MANAGE_WORKSPACE_SETTINGS', eventType: '',
    })
  }
  // Not written: give the claim back so the retry raises it.
  if (!written && claim === 'claimed') await releaseAlert(service, row.id, key)
  return written
}

async function claimAlert(service: any, emailLogId: string, key: string): Promise<'claimed' | 'already' | 'unavailable'> {
  try {
    const { data, error } = await service.rpc('claim_email_alert', { p_email_log_id: emailLogId, p_key: key })
    if (error) { console.error('[resend-webhook] alert claim unavailable:', error.message); return 'unavailable' }
    return data === true ? 'claimed' : 'already'
  } catch (e) { console.error('[resend-webhook] alert claim threw:', e); return 'unavailable' }
}

async function releaseAlert(service: any, emailLogId: string, key: string) {
  try { await service.rpc('release_email_alert', { p_email_log_id: emailLogId, p_key: key }) }
  catch (e) { console.error('[resend-webhook] could not release alert claim:', e) }
}

// FEATURE (independent pass, section 14): the bounce alert above reaches only the sender, once. Nothing
// stayed on the CLIENT record, so the next teammate to send that client something had no idea the
// address was dead. The client's primary email (only — a bounced CC is not the client's address) is now
// marked on the record (shown on the client page and list) and cleared again by the next successful
// delivery to it or by editing the address. Best-effort: a failure here never fails the webhook.
// FIX (independent pass 2, section 14): the client is matched case-INSENSITIVELY. `to` is lower-cased here, but a
// client row whose email was stored with capitals (legacy rows, and workspaces that predate the lower(email)
// unique index) never matched an exact `.eq('email', to)`, so its bounce marker was silently never written.
async function trackClientEmailHealth(service: any, row: any, status: string, address?: string) {
  try {
    const to = (address || String((row.to_emails || [])[0] || '')).trim().toLowerCase()
    if (!to || !row.workspace_id) return
    // FIX (independent pass 15, section 14 — B2): all three branches matched the client with `ilike(escapeLike(to))`
    // alone. escapeLike() turns a `*` into the single-character wildcard `_` (PostgREST cannot escape `*`), and `*` is a
    // legal local-part character, so an event for `a*@x.com` also matched `ab@x.com` / `a1@x.com`: a bounce or spam
    // complaint stamped the red marker on an UNRELATED client, and a delivery to one cleared another client's genuine
    // bounce. Every other ilike lookup on this address (contacts, project creation, Guardian inbound) was already
    // followed by an exact sameEmail() check (pass 13); this one was missed. The candidates are now read, filtered to
    // the exact case-insensitive address, and written by id.
    const { data: hits, error: selErr } = await service.from('clients').select('id, email, email_bounce_kind, email_bounced_at')
      .eq('workspace_id', row.workspace_id).ilike('email', escapeLike(to)).limit(25)
    if (selErr) { console.error('[resend-webhook] could not look up client for email health:', selErr.message); return }
    const matched = (hits || []).filter((c: any) => sameEmail(c.email, to))
    if (status === 'complained') {
      const ids = matched.map((c: any) => c.id)
      if (ids.length) {
        const { error } = await service.from('clients')
          .update({ email_bounced_at: new Date().toISOString(), email_bounce_kind: 'complaint' }).in('id', ids)
        if (error) console.error('[resend-webhook] could not mark client email complaint:', error.message)
      }
    } else if (status === 'bounced') {
      // A spam complaint outranks a bounce ("stays until the address is changed"). Bounce events for an address are
      // now processed even when the message status did not advance, so one arriving after a complaint must not turn
      // the marker back into a plain bounce — which the next successful delivery would then clear.
      const ids = matched.filter((c: any) => c.email_bounce_kind !== 'complaint').map((c: any) => c.id)
      if (ids.length) {
        const { error } = await service.from('clients')
          .update({ email_bounced_at: new Date().toISOString(), email_bounce_kind: 'bounce' }).in('id', ids)
        if (error) console.error('[resend-webhook] could not mark client email bounce:', error.message)
      }
    } else if (status === 'delivered') {
      // Only a plain bounce clears on delivery — a spam complaint stays until the address is changed.
      // Webhooks arrive out of order: a late "delivered" for an OLDER email must not wipe a bounce recorded for a newer
      // one. Only a delivery of an email sent after the marker was set proves the address works again.
      const sentAt = Date.parse(row.created_at || '')
      const ids = matched.filter((c: any) => c.email_bounce_kind === 'bounce' && (
        !Number.isFinite(sentAt) || !c.email_bounced_at || Date.parse(c.email_bounced_at) <= sentAt
      )).map((c: any) => c.id)
      if (ids.length) {
        const { error } = await service.from('clients')
          .update({ email_bounced_at: null, email_bounce_kind: null }).in('id', ids)
        if (error) console.error('[resend-webhook] could not clear client email bounce:', error.message)
      }
    }
  } catch (e) {
    console.error('[resend-webhook] client email health update failed:', e)
  }
}
