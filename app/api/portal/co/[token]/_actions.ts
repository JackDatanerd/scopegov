export const runtime = 'nodejs'

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

async function resolveCoAndToken(token: string, service: any) {
  const { data: revoked } = await (service as any)
    .from('revoked_tokens').select('id').eq('token', token).single()
  if (revoked) return { error: 'Link no longer active', status: 410 }

  const { data: co } = await (service as any)
    .from('change_orders')
    .select(`id,title,status,flag_id,project_id,workspace_id,
      projects(id,name,currency,clients(name,email),workspaces(agency_name))`)
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

  const { reason } = await request.json().catch(() => ({ reason: null }))
  const result     = await resolveCoAndToken(token, service)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

  const { co } = result
  if (!['awaiting_response'].includes(co.status))
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
    .eq('status', 'awaiting_response')
    .select('id')

  if (updateErr) return NextResponse.json({ error: 'Failed to decline' }, { status: 500 })
  if (!updated || updated.length === 0)
    return NextResponse.json({ error: 'This change order was already responded to' }, { status: 409 })

  // Revoke token
  try {
    await (service as any).from('revoked_tokens').insert({
      token, token_type: 'co', reason: 'declined',
    })
  } catch (e) { console.error('Token revoke insert failed (non-fatal):', e) }

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
  try {
    const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_declined', co.project_id)
    if (emails.length) {
      const client = co.projects?.clients
      await sendCoDeclinedEmail({
        to: emails,
        clientName: client?.name || 'Client',
        projectName: co.projects?.name || '',
        coTitle: co.title,
        reason,
        projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
      })
    }
  } catch (e) { console.error('CO declined email failed:', e) }
  await notifyMembersWithPermission(service, {
    workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_declined',
    type: 'co_declined', title: `CO declined — ${co.title}`,
    body: reason ? `${co.projects?.clients?.name}: ${reason}` : `${co.projects?.clients?.name} declined this change order.`,
    entityType: 'project', entityId: co.project_id, projectId: co.project_id,
  })

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

  const { counterAmount, counterNote } = await request.json()
  // FIX (audit round 3): `!counterAmount` is false for any non-empty
  // string, and a NaN comparison (`NaN <= 0`) is always false too — so a
  // non-numeric counterAmount like "abc" slipped past this check entirely.
  // JSON.stringify(NaN) serializes to `null`, so the row ended up with a
  // silently null counter_amount instead of a rejected request. Parse
  // once and validate the actual number.
  const parsedAmount = parseFloat(counterAmount)
  if (!counterAmount || !Number.isFinite(parsedAmount) || parsedAmount <= 0)
    return NextResponse.json({ error: 'Counter amount must be greater than zero' }, { status: 400 })

  const result  = await resolveCoAndToken(token, service)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

  const { co } = result
  if (!['awaiting_response'].includes(co.status))
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
    .eq('status', 'awaiting_response')
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
    metadata: { counter_amount: parsedAmount, note: counterNote },
  })

  // Notify agency (Event 14)
  try {
    // FIX (portal audit, section 18): this used to pass `undefined` for
    // eventType — unlike the decline path just above, which correctly
    // passes 'co_declined' — so counter-offer emails ignored notification
    // preferences entirely. Members who'd opted out of 'co_countered'
    // still got these.
    // FIX (deep audit, notifications section): hand-rolled Resend call
    // with no shared branding/footer — see sendCoCounteredEmail.
    const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_countered', co.project_id)
    if (emails.length) {
      const client = co.projects?.clients
      await sendCoCounteredEmail({
        to: emails,
        clientName: client?.name || 'Client',
        coTitle: co.title,
        counterAmount: parsedAmount,
        currency: co.projects?.currency || 'USD',
        counterNote,
        projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
      })
    }
  } catch (e) { console.error('CO counter email failed:', e) }
  await notifyMembersWithPermission(service, {
    workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_countered',
    type: 'co_countered', title: `Counter offer — ${co.title}`,
    body: `${co.projects?.clients?.name} proposed ${co.projects?.currency || 'USD'} ${parsedAmount.toLocaleString()}.`,
    entityType: 'project', entityId: co.project_id, projectId: co.project_id,
  })

  return NextResponse.json({
    ok: true,
    message: 'Your counter offer has been submitted. The agency will review and respond.',
  })
}
