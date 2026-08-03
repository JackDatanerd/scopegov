export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendApprovalReminder } from '@/lib/approvals/engine'

function verifyCronSecret(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service   = createServiceClient()
    const now       = new Date()
    // Shorter window than co-stall's 5 days — an approval gate is blocking
    // a send that's otherwise ready to go out, not an open client
    // negotiation, so it's worth nudging sooner.
    const threshold = 2 // days
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()

    // updated_at doubles as "last activity on this request" — it moves
    // forward on step-advance and gets bumped here after a reminder, so
    // a request that just changed step (or was just reminded) won't be
    // picked up again until it's been quiet for the full window again.
    const { data: stale } = await (service as any)
      .from('approval_requests')
      .select('id, workspace_id')
      .eq('status', 'pending')
      .lt('updated_at', cutoff)

    let reminded = 0
    for (const r of (stale || [])) {
      try {
        const sent = await sendApprovalReminder(service, r.id)
        if (sent) {
          await (service as any).from('approval_requests')
            .update({ updated_at: now.toISOString() }).eq('id', r.id)
          await (service as any).from('audit_log').insert({
            workspace_id: r.workspace_id,
            actor_id:     null,
            actor_email:  'cron@scopegov.app',
            actor_name:   'ScopeGov',
            event_type:   'approval.reminder_sent',
            entity_type:  'approval_request',
            entity_id:    r.id,
            metadata:     { days_pending: threshold },
          })
          reminded++
        }
      } catch (e) { console.error('Approval reminder error:', e) }
    }

    return NextResponse.json({ ok: true, reminded })
  } catch (err) {
    console.error('Approval stall cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET, not POST (see
// co-stall/route.ts for the full explanation) — alias so both work.
export const GET = POST
