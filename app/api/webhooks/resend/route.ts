export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyResendSignature, nextEmailStatus, classifyEmailKind, bounceAlertBody } from '@/lib/email/webhook'
import { notifyUsers, notifyMembersWithPermission } from '@/lib/utils/notify'
import type { Permission } from '@/lib/supabase/types'
import { escapeLike } from '@/lib/utils/escape-like'

// Resend delivery webhook (configure in the Resend dashboard → Webhooks → this URL, events
// email.delivered / email.delivery_delayed / email.bounced / email.complained / email.failed, and
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
      .select('id, workspace_id, kind, entity_type, entity_id, project_id, actor_id, to_emails, status')
      .eq('provider_id', emailId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!row) {
      // The log row is written right AFTER the send returns, so an event can beat it. Fail (Resend retries after a
      // few seconds) while the event is fresh; an old event for an email we never logged is simply not ours.
      if (eventAgeMs(event) < UNLOGGED_RETRY_WINDOW_MS) return NextResponse.json({ error: 'Email not logged yet' }, { status: 503 })
      return NextResponse.json({ ok: true, untracked: true })
    }
    const address = impacted || firstAddress(row.to_emails)

    const next = nextEmailStatus(row.status, type)
    if (!next) {
      // A delivery to THIS address proves it works even when the message-level status did not advance (another
      // recipient's event landed first). Clearing is idempotent and address-scoped, so it is always safe.
      if (type === 'email.delivered') await trackClientEmailHealth(service, row, 'delivered', address)
      return NextResponse.json({ ok: true, unchanged: true })
    }

    // Guarded on the status we read, so a concurrent/retried delivery of the same event is a no-op
    // and — importantly — can't raise the alert twice.
    const { data: updated, error: upErr } = await service
      .from('email_log').update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', row.status).select('id')
    if (upErr) throw new Error(upErr.message)
    if (!updated || updated.length === 0) return NextResponse.json({ ok: true, unchanged: true })

    if (next === 'bounced' || next === 'complained') {
      const alerted = await alertSender(service, row, next, address)
      if (!alerted) {
        // The status already moved, so a retry would see "unchanged" and the alert would be lost for good. Put the
        // status back (guarded on what we wrote) and fail, so Resend redelivers the event and the alert is retried.
        await service.from('email_log').update({ status: row.status }).eq('id', row.id).eq('status', next)
        throw new Error('bounce alert could not be written')
      }
    }
    await trackClientEmailHealth(service, row, next, address)
    return NextResponse.json({ ok: true, status: next })
  } catch (err) {
    console.error('[resend-webhook] processing failed:', err)
    // 500 → Resend retries; the guarded update above makes the retry safe.
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}

const UNLOGGED_RETRY_WINDOW_MS = 2 * 60 * 1000

function firstAddress(v: unknown): string {
  const first = Array.isArray(v) ? v[0] : v
  return typeof first === 'string' ? first.trim().toLowerCase() : ''
}

function eventAgeMs(event: any): number {
  const t = Date.parse(event?.created_at || event?.data?.created_at || '')
  return Number.isFinite(t) ? Date.now() - t : Infinity
}

/** Resolves true when the alert was written (or no one was eligible to receive it). */
async function alertSender(service: any, row: any, status: 'bounced' | 'complained', address: string): Promise<boolean> {
  const { docKind, role } = classifyEmailKind(row.kind)
  const doc = DOC_BY_KIND[docKind]
  const to = address || (row.to_emails || [])[0] || 'the client'
  const what = doc ? doc.label : 'email'

  const title = status === 'bounced'
    ? `Email to ${to} bounced`
    : `${to} marked your email as spam`
  const body = status === 'bounced'
    ? bounceAlertBody(role, what)
    : `Your ${what} email was reported as spam. Avoid further emails to this address until you have spoken to them.`

  const shared = {
    workspaceId: row.workspace_id,
    // Mandatory: no eventType, so no preference can silence a delivery failure.
    title, body,
    entityType: row.project_id ? 'project' : undefined,
    entityId: row.project_id || undefined,
    projectId: row.project_id || undefined,
  }
  const type = doc ? `${doc.prefix}_email_${status}` : `email_${status}`

  // The person who triggered the send is the one who can fix it; fall back to whoever manages that
  // kind of document (e.g. an automatic send after approval has no single actor).
  if (row.actor_id) {
    const r = await notifyUsers(service, { ...shared, type, recipientIds: [row.actor_id] })
    if (r.recipients.length > 0) return r.inserted
  }
  return notifyMembersWithPermission(service, {
    ...shared, type, permission: doc?.permission || 'MANAGE_WORKSPACE_SETTINGS', eventType: '',
  })
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
    if (status === 'bounced' || status === 'complained') {
      const { error } = await service.from('clients')
        .update({ email_bounced_at: new Date().toISOString(), email_bounce_kind: status === 'complained' ? 'complaint' : 'bounce' })
        .eq('workspace_id', row.workspace_id).ilike('email', escapeLike(to))
      if (error) console.error('[resend-webhook] could not mark client email bounce:', error.message)
    } else if (status === 'delivered') {
      // Only a plain bounce clears on delivery — a spam complaint stays until the address is changed.
      const { error } = await service.from('clients')
        .update({ email_bounced_at: null, email_bounce_kind: null })
        .eq('workspace_id', row.workspace_id).ilike('email', escapeLike(to)).eq('email_bounce_kind', 'bounce')
      if (error) console.error('[resend-webhook] could not clear client email bounce:', error.message)
    }
  } catch (e) {
    console.error('[resend-webhook] client email health update failed:', e)
  }
}
