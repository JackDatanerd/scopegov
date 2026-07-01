export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'

async function resolveCoAndToken(token: string, service: any) {
  const { data: revoked } = await (service as any)
    .from('revoked_tokens').select('id').eq('token', token).single()
  if (revoked) return { error: 'Link no longer active', status: 410 }

  const { data: co } = await (service as any)
    .from('change_orders')
    .select(`id,title,status,flag_id,project_id,workspace_id,
      projects(id,name,currency,clients(name,email),workspaces(agency_name,jwt_secret))`)
    .eq('token', token).single()

  if (!co) return { error: 'Not found', status: 404 }

  try {
    const secret = new TextEncoder().encode(co.projects.workspaces.jwt_secret)
    await jwtVerify(token, secret)
  } catch { return { error: 'Invalid or expired link', status: 401 } }

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
      actorId: co.projects?.clients?.email || 'client',
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
  const { reason } = await request.json().catch(() => ({ reason: null }))
  const service    = createServiceClient()
  const result     = await resolveCoAndToken(token, service)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

  const { co } = result
  if (!['awaiting_response'].includes(co.status))
    return NextResponse.json({ error: 'CO cannot be declined in current status' }, { status: 409 })

  const now = new Date().toISOString()
  await (service as any).from('change_orders').update({
    status: 'declined', declined_at: now, declined_reason: reason || null,
    responded_at: now, updated_at: now,
  }).eq('id', co.id)

  // Revoke token
  await (service as any).from('revoked_tokens').insert({
    token, token_type: 'co', reason: 'declined',
  }).catch(() => {})

  // BUG-048: revert linked flag on decline
  await revertFlagIfLinked(service, co, 'CO declined by client', null)

  await logAudit(service, {
    workspaceId: co.workspace_id,
    actorId: co.projects?.clients?.email || 'client',
    actorEmail: co.projects?.clients?.email || '',
    actorName: co.projects?.clients?.name || 'Client',
    eventType: 'co.declined', entityType: 'change_order',
    entityId: co.id, entityName: co.title,
    metadata: { reason },
  })

  // Notify agency
  try {
    const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS')
    if (emails.length) {
      const { Resend } = await import('resend')
      const resend = new Resend(process.env.RESEND_API_KEY)
      const client = co.projects?.clients
      await resend.emails.send({
        from: `ScopeGov <${process.env.RESEND_FROM_EMAIL}>`,
        to: emails,
        subject: `${client?.name} declined the change order — ${co.title}`,
        html: `<p><strong>${client?.name}</strong> has declined the change order <strong>${co.title}</strong> on <strong>${co.projects?.name}</strong>.</p>
        ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
        <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co">View in ScopeGov →</a></p>`,
      })
    }
  } catch (e) { console.error('CO declined email failed:', e) }

  return NextResponse.json({
    ok: true,
    message: 'You have declined this change order. The agency has been notified.',
  })
}

// ── COUNTER ──────────────────────────────────────────────────
export async function POST_COUNTER(request: NextRequest, token: string) {
  const { counterAmount, counterNote } = await request.json()
  if (!counterAmount || parseFloat(counterAmount) <= 0)
    return NextResponse.json({ error: 'Counter amount must be greater than zero' }, { status: 400 })

  const service = createServiceClient()
  const result  = await resolveCoAndToken(token, service)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

  const { co } = result
  if (!['awaiting_response'].includes(co.status))
    return NextResponse.json({ error: 'CO cannot be countered in current status' }, { status: 409 })

  const now = new Date().toISOString()
  await (service as any).from('change_orders').update({
    status:        'countered',
    counter_amount: parseFloat(counterAmount),
    counter_note:  counterNote || null,
    responded_at:  now,
    updated_at:    now,
  }).eq('id', co.id)

  await logAudit(service, {
    workspaceId: co.workspace_id,
    actorId: co.projects?.clients?.email || 'client',
    actorEmail: co.projects?.clients?.email || '',
    actorName: co.projects?.clients?.name || 'Client',
    eventType: 'co.countered', entityType: 'change_order',
    entityId: co.id, entityName: co.title,
    metadata: { counter_amount: counterAmount, note: counterNote },
  })

  // Notify agency (Event 14)
  try {
    const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS')
    if (emails.length) {
      const { Resend } = await import('resend')
      const resend = new Resend(process.env.RESEND_API_KEY)
      const client = co.projects?.clients
      await resend.emails.send({
        from: `ScopeGov <${process.env.RESEND_FROM_EMAIL}>`,
        to: emails,
        subject: `Counter offer received — ${co.title}`,
        html: `<p><strong>${client?.name}</strong> has proposed a counter offer of <strong>${co.projects?.currency || 'USD'} ${parseFloat(counterAmount).toLocaleString()}</strong> on <strong>${co.title}</strong>.</p>
        ${counterNote ? `<p><strong>Note:</strong> ${counterNote}</p>` : ''}
        <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co">Review counter in ScopeGov →</a></p>`,
      })
    }
  } catch (e) { console.error('CO counter email failed:', e) }

  return NextResponse.json({
    ok: true,
    message: 'Your counter offer has been submitted. The agency will review and respond.',
  })
}
