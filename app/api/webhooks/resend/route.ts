export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyResendSignature, nextEmailStatus } from '@/lib/email/webhook'
import { notifyUsers, notifyMembersWithPermission } from '@/lib/utils/notify'
import type { Permission } from '@/lib/supabase/types'

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

  try {
    const service = createServiceClient() as any
    const { data: row, error } = await service
      .from('email_log')
      .select('id, workspace_id, kind, entity_type, entity_id, project_id, actor_id, to_emails, status')
      .eq('provider_id', emailId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!row) return NextResponse.json({ ok: true, untracked: true }) // an email we didn't log

    const next = nextEmailStatus(row.status, type)
    if (!next) return NextResponse.json({ ok: true, unchanged: true })

    // Guarded on the status we read, so a concurrent/retried delivery of the same event is a no-op
    // and — importantly — can't raise the alert twice.
    const { data: updated, error: upErr } = await service
      .from('email_log').update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', row.status).select('id')
    if (upErr) throw new Error(upErr.message)
    if (!updated || updated.length === 0) return NextResponse.json({ ok: true, unchanged: true })

    if (next === 'bounced' || next === 'complained') await alertSender(service, row, next)
    return NextResponse.json({ ok: true, status: next })
  } catch (err) {
    console.error('[resend-webhook] processing failed:', err)
    // 500 → Resend retries; the guarded update above makes the retry safe.
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}

async function alertSender(service: any, row: any, status: 'bounced' | 'complained') {
  const docKind = String(row.kind || '').split('.')[0]
  const doc = DOC_BY_KIND[docKind]
  const to = (row.to_emails || [])[0] || 'the client'
  const what = doc ? doc.label : 'email'
  const isReminder = String(row.kind || '').endsWith('.reminder')

  const title = status === 'bounced'
    ? `Email to ${to} bounced`
    : `${to} marked your email as spam`
  const body = status === 'bounced'
    ? `Your ${isReminder ? 'reminder for the' : ''} ${what} was not delivered. Check the address on the client record, then resend.`.replace(/\s+/g, ' ')
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
    if (r.recipients.length > 0) return
  }
  await notifyMembersWithPermission(service, {
    ...shared, type, permission: doc?.permission || 'MANAGE_WORKSPACE_SETTINGS', eventType: '',
  })
}
