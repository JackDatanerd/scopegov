export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

function verifyCronSecret(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service   = createServiceClient()
    const now       = new Date()
    const threshold = 5 // days — spec default
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()

    // BUG-055: ONLY awaiting_response. 'countered' COs do NOT auto-stall.
    // A countered CO has an active negotiation — stalling it makes no sense.
    const { data: staleCOs } = await (service as any)
      .from('change_orders')
      .select('id, title, project_id, workspace_id, sent_at')
      .eq('status', 'awaiting_response')  // NOT countered
      .lt('sent_at', cutoff)
      .is('deleted_at', null)

    let stalled = 0
    for (const co of (staleCOs || [])) {
      try {
        await (service as any).from('change_orders').update({
          status:     'stalled',
          updated_at: now.toISOString(),
        }).eq('id', co.id).eq('status', 'awaiting_response') // double-check status hasn't changed

        await (service as any).from('audit_log').insert({
          workspace_id: co.workspace_id,
          actor_id:     null,
          actor_email:  'cron@scopegov.app',
          actor_name:   'ScopeGov',
          event_type:   'co.marked_stalled',
          entity_type:  'change_order',
          entity_id:    co.id,
          entity_name:  co.title,
          metadata:     { days_since_sent: threshold },
        })
        stalled++
      } catch (e) { console.error('CO stall error:', e) }
    }

    return NextResponse.json({ ok: true, stalled })
  } catch (err) {
    console.error('CO stall cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}
