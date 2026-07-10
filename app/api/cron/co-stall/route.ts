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

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. The 3 sub-hourly jobs (sow-stall, co-stall, guardian-health) are
// triggered by the GitHub Actions workflow via POST, which still works.
// Exporting GET as an alias makes both invocation paths work.
export const GET = POST
