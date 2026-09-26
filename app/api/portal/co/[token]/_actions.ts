export const runtime = 'nodejs'

import { formatMoney } from '@/lib/utils/money'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { sendCoDeclinedEmail, sendCoCounteredEmail } from '@/lib/email/templates'
import { getWorkspaceJwtSecret, isWorkspaceDeleted } from '@/lib/utils/workspace-secret'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'
import { cleanTextField } from '@/lib/utils/sanitize'
import { checkedSend } from '@/lib/email/delivery'
import { sendClientResponseReceivedEmail } from '@/lib/email/templates'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { parseTableAmount } from '@/lib/sow/table-schema'

// 'stalled' is set by the co-stall cron after 5 days without a reply. It is an AGENCY-side attention
// flag, but the portal used to treat it as a lock: the client's still-valid link answered Accept /
// Decline / Counter with "cannot be responded to", and the send email never mentioned a 5-day deadline.
// A stalled CO is still a live offer until it expires, so the client can answer it.
export const CLIENT_RESPONDABLE_STATUSES = ['awaiting_response', 'stalled']

async function resolveCoAndToken(token: string, service: any) {
  const { data: revoked } = await (service as any)
    .from('revoked_tokens').select('id').eq('token', token).single()
  if (revoked) return { error: 'Link no longer active', status: 410 }

  const { data: co } = await (service as any)
    .from('change_orders')
    .select(`id,title,status,flag_id,project_id,workspace_id,
      projects(id,name,currency,client_id,clients(name,email,cc_emails),workspaces(agency_name,brand_colour))`)
    .eq('token', token).single()

  if (!co) return { error: 'Not found', status: 404 }

  // jwt_secret lives in workspace_secrets now, not on workspaces itself —
  // see migration 013.
  try {
    const jwtSecret = await getWorkspaceJwtSecret(service, co.workspace_id)
    if (!jwtSecret) throw new Error('no secret')
    const secret = new TextEncoder().encode(jwtSecret)
    await jwtVerify(token, secret)
  } catch { return { error: 'Invalid or expired link', status: 401 } }

  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — flagship
  // finding): see isWorkspaceDeleted's own comment in workspace-secret.ts.
  // Single choke point for both decline and counter below, same as the
  // JWT check right above it.
  if (await isWorkspaceDeleted(service, co.workspace_id))
    return { error: 'This link is no longer active', status: 410 }

  return { co }
}

async function revertFlagIfLinked(service: any, co: any, reason: string, session: any) {
  // BUG-048: flag reversion fires on decline too (same rule as close/withdraw)
  if (!co.flag_id) return
  const { data: flag } = await (service as any)
    .from('guardian_flags').select('id,status').eq('id', co.flag_id).single()
  if (flag?.status === 'converted_to_co') {
    const now = new Date().toISOString()
    await (service as any).from('guardian_flags').update({
      status: 'open', change_order_id: null, updated_at: now,
    }).eq('id', co.flag_id)
    await logAudit(service, {
      workspaceId: co.workspace_id,
      // FIX (build, Reports & Audit re-pass): actor_id is `uuid REFERENCES
    // users(id)` — a client is never a platform user, so passing their
    // email/name string here made every insert below fail Postgres's uuid
    // cast. supabase-js doesn't throw on a DB error (it returns
    // {error}, unchecked here), so this failed completely silently —
    // this event never once reached audit_log. null is the correct
    // "no platform-user actor" value, same as every automated/webhook
    // call site already uses; actorEmail/actorName (both plain text
    // columns) still carry the real client identity.
    actorId: null,
      actorEmail: co.projects?.clients?.email || '',
      actorName: co.projects?.clients?.name || 'Client',
      eventType: 'flag.reverted_to_open', entityType: 'guardian_flag',
      entityId: co.flag_id, entityName: co.projects?.name,
      metadata: { co_id: co.id, reason },
    })
  }
}

// ── DECLINE ──────────────────────────────────────────────────
export async function POST_DECLINE(request: NextRequest, token: string) {
  const service    = createServiceClient()
  // FEATURE (portal audit, section 18): see migration 030.
  const clientIp = getClientIp(request)
  const rl = await checkPortalRateLimit(service, clientIp, 'co.decline')
  if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
  await recordPortalAction(service, clientIp, 'co.decline')

  const declineBody = await request.json().catch(() => ({} as any))
  // Free text from an unauthenticated link holder: type-checked, markup-stripped and capped.
  const cleanedReason = cleanTextField(declineBody?.reason, 2000)
  if (cleanedReason === null) return NextResponse.json({ error: 'reason must be text' }, { status: 400 })
  const reason: string | undefined = cleanedReason || undefined
  const result     = await resolveCoAndToken(token, service)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

  const { co } = result
  if (!CLIENT_RESPONDABLE_STATUSES.includes(co.status))
    return NextResponse.json({ error: 'CO cannot be declined in current status' }, { status: 409 })

  const now = new Date().toISOString()
  // FIX (re-audit, race-condition finding): this used to write
  // unconditionally on `.eq('id', co.id)` — a read-then-write gap
  // identical to the one already fixed on the accept/countersign paths
  // (see finalize-co.ts). A client firing Accept and Decline for the
  // same CO near-simultaneously could let Accept's CAS-protected write
  // land first (status -> 'accepted', fully finalized with a real
  // signature and agency notification), then have this unconditional
  // write blindly flip it back to 'declined' anyway. CAS on the
  // still-'awaiting_response' status here closes that window: only the
  // request that actually wins the race continues past this point.
  const { data: updated, error: updateErr } = await (service as any)
    .from('change_orders')
    .update({
      status: 'declined', declined_at: now, declined_reason: reason || null,
      responded_at: now, updated_at: now,
    })
    .eq('id', co.id)
    .in('status', CLIENT_RESPONDABLE_STATUSES)
    .select('id')

  if (updateErr) return NextResponse.json({ error: 'Failed to decline' }, { status: 500 })
  if (!updated || updated.length === 0)
    return NextResponse.json({ error: 'This change order was already responded to' }, { status: 409 })

  // Revoke token
  const { error: declineRevokeErr } = await (service as any).from('revoked_tokens').insert({
    token, token_type: 'co', reason: 'declined', document_id: co.id,
  })
  if (declineRevokeErr) console.error('CO decline: token revoke insert failed (non-fatal):', declineRevokeErr.message)

  // BUG-048: revert linked flag on decline
  await revertFlagIfLinked(service, co, 'CO declined by client', null)

  await logAudit(service, {
    workspaceId: co.workspace_id,
    // FIX (build, Reports & Audit re-pass): actor_id is `uuid REFERENCES
    // users(id)` — a client is never a platform user, so passing their
    // email/name string here made every insert below fail Postgres's uuid
    // cast. supabase-js doesn't throw on a DB error (it returns
    // {error}, unchecked here), so this failed completely silently —
    // this event never once reached audit_log. null is the correct
    // "no platform-user actor" value, same as every automated/webhook
    // call site already uses; actorEmail/actorName (both plain text
    // columns) still carry the real client identity.
    actorId: null,
    actorEmail: co.projects?.clients?.email || '',
    actorName: co.projects?.clients?.name || 'Client',
    eventType: 'co.declined', entityType: 'change_order',
    entityId: co.id, entityName: co.title,
    metadata: { reason },
  })

  // Notify agency
  // FIX (deep audit, notifications section): this was a hand-rolled Resend
  // call with no shared branding/footer, unlike every comparable
  // agency-notify email — see sendCoDeclinedEmail in lib/email/templates.ts.
  const client = co.projects?.clients
  try {
    const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_declined', co.project_id)
    if (emails.length) {
      // FIX (re-audit, section 18): raw try/catch, not checkedSend — a Resend-level rejection
      // resolved normally instead of throwing, so this silently "succeeded" while the agency
      // never actually heard the CO was declined. The counter flow just below already gets this
      // right (checkedSend, imported at the top of this file); decline was the outlier.
      await checkedSend(() => sendCoDeclinedEmail({
        to: emails,
        clientName: client?.name || 'Client',
        projectName: co.projects?.name || '',
        coTitle: co.title,
        reason,
        projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
      }), 'CO declined (agency) email')
    }
  } catch (e) { console.error('CO declined email failed:', e) }
  await notifyMembersWithPermission(service, {
    workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_declined',
    type: 'co_declined', title: `CO declined — ${co.title}`,
    body: reason ? `${co.projects?.clients?.name}: ${reason.slice(0, 200)}` : `${co.projects?.clients?.name} declined this change order.`,
    entityType: 'project', entityId: co.project_id, projectId: co.project_id,
  })
  // FIX (re-audit, section 18 — feature gap): every other client-initiated portal response (SOW
  // decline/request-changes, CO *counter*, invoice dispute) sends the client a "we received your
  // response" receipt — CO decline was the one exception, confirmed by grep across the whole
  // portal section. The client had only the JSON success message, gone the moment they navigate away.
  if (client?.email) {
    const cc = await withPrimaryContactCc(service, co.projects?.client_id, client.email, client.cc_emails, 'co')
    const replyTo = await resolveReplyTo(service, co.workspace_id, null)
    await checkedSend(() => sendClientResponseReceivedEmail({
      replyTo,
      to: client.email, cc, clientName: client.name, agencyName: co.projects?.workspaces?.agency_name || '',
      projectName: co.projects?.name || '', documentLabel: 'Change Order', response: 'declined',
      note: reason ? reason.slice(0, 500) : null, brandColour: co.projects?.workspaces?.brand_colour,
    }), 'CO declined (client receipt)')
  }

  return NextResponse.json({
    ok: true,
    message: 'You have declined this change order. The agency has been notified.',
  })
}

// ── COUNTER ──────────────────────────────────────────────────
export async function POST_COUNTER(request: NextRequest, token: string) {
  const service = createServiceClient()
  // FEATURE (portal audit, section 18): see migration 030.
  const clientIp = getClientIp(request)
  const rl = await checkPortalRateLimit(service, clientIp, 'co.counter')
  if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
  await recordPortalAction(service, clientIp, 'co.counter')

  // Free text + a number from an unauthenticated link holder. This body was parsed with no catch (bad JSON -> a
  // bare 500) and counterNote was stored, audited and emailed verbatim at any length — into an append-only
  // audit_log. Type-checked, markup-stripped and capped like the sibling decline reason.
  const counterBody = await request.json().catch(() => ({} as any))
  const counterAmount = counterBody?.counterAmount
  const cleanedNote = cleanTextField(counterBody?.counterNote, 2000)
  if (cleanedNote === null) return NextResponse.json({ error: 'counterNote must be text' }, { status: 400 })
  const counterNote: string | undefined = cleanedNote || undefined
  // FIX (audit round 3): `!counterAmount` is false for any non-empty
  // string, and a NaN comparison (`NaN <= 0`) is always false too — so a
  // non-numeric counterAmount like "abc" slipped past this check entirely.
  // JSON.stringify(NaN) serializes to `null`, so the row ended up with a
  // silently null counter_amount instead of a rejected request. Parse
  // once and validate the actual number.
  const parsedAmount = parseFloat(counterAmount)
  if (!counterAmount || !Number.isFinite(parsedAmount) || parsedAmount <= 0)
    return NextResponse.json({ error: 'Counter amount must be greater than zero' }, { status: 400 })
  // Upper bound: an absurd figure (1e20) overflowed the numeric column and surfaced as an opaque 500.
  if (parsedAmount > 999_999_999.99)
    return NextResponse.json({ error: 'Counter amount is too large' }, { status: 400 })

  const result  = await resolveCoAndToken(token, service)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

  const { co } = result
  if (!CLIENT_RESPONDABLE_STATUSES.includes(co.status))
    return NextResponse.json({ error: 'CO cannot be countered in current status' }, { status: 409 })

  const now = new Date().toISOString()
  // FIX (re-audit, race-condition finding): same class of gap as
  // POST_DECLINE above — an unconditional write here let a losing
  // Counter request stomp a CO an Accept request had already CAS-won and
  // finalized in the same instant. Guard the write the same way.
  const { data: updated, error: updateErr } = await (service as any)
    .from('change_orders')
    .update({
      status:        'countered',
      counter_amount: parsedAmount,
      counter_note:  counterNote || null,
      responded_at:  now,
      updated_at:    now,
    })
    .eq('id', co.id)
    .in('status', CLIENT_RESPONDABLE_STATUSES)
    .select('id')

  if (updateErr) return NextResponse.json({ error: 'Failed to submit counter offer' }, { status: 500 })
  if (!updated || updated.length === 0)
    return NextResponse.json({ error: 'This change order was already responded to' }, { status: 409 })

  await logAudit(service, {
    workspaceId: co.workspace_id,
    // FIX (build, Reports & Audit re-pass): actor_id is `uuid REFERENCES
    // users(id)` — a client is never a platform user, so passing their
    // email/name string here made every insert below fail Postgres's uuid
    // cast. supabase-js doesn't throw on a DB error (it returns
    // {error}, unchecked here), so this failed completely silently —
    // this event never once reached audit_log. null is the correct
    // "no platform-user actor" value, same as every automated/webhook
    // call site already uses; actorEmail/actorName (both plain text
    // columns) still carry the real client identity.
    actorId: null,
    actorEmail: co.projects?.clients?.email || '',
    actorName: co.projects?.clients?.name || 'Client',
    eventType: 'co.countered', entityType: 'change_order',
    entityId: co.id, entityName: co.title,
    metadata: { counter_amount: parsedAmount, ...(counterNote ? { note: counterNote } : {}) },
  })

  // Notify agency (Event 14)
  {
    const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_countered', co.project_id).catch(() => [] as string[])
    const client = co.projects?.clients
    if (emails.length) {
      await checkedSend(() => sendCoCounteredEmail({
        to: emails,
        clientName: client?.name || 'Client',
        coTitle: co.title,
        counterAmount: parsedAmount,
        currency: co.projects?.currency || 'USD',
        counterNote,
        projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
      }), 'CO countered (agency) email')
    }
    if (client?.email) {
      const cc = await withPrimaryContactCc(service, co.projects?.client_id, client.email, client.cc_emails, 'co')
      const replyTo = await resolveReplyTo(service, co.workspace_id, null)
      await checkedSend(() => sendClientResponseReceivedEmail({
        replyTo,
        to: client.email, cc, clientName: client.name, agencyName: co.projects?.workspaces?.agency_name || '',
        projectName: co.projects?.name || '', documentLabel: 'Change Order', response: 'countered',
        note: `${formatMoney(parsedAmount, co.projects?.currency)}${counterNote ? ` — ${counterNote.slice(0, 400)}` : ''}`,
        brandColour: co.projects?.workspaces?.brand_colour,
      }), 'CO countered (client receipt)')
    }
  }
  await notifyMembersWithPermission(service, {
    workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_countered',
    type: 'co_countered', title: `Counter offer — ${co.title}`,
    body: `${co.projects?.clients?.name} proposed ${formatMoney(parsedAmount, co.projects?.currency)}.`,
    entityType: 'project', entityId: co.project_id, projectId: co.project_id,
  })

  return NextResponse.json({
    ok: true,
    message: 'Your counter offer has been submitted. The agency will review and respond.',
  })
}
