export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

function verifyCronSecret(request: NextRequest): boolean {
  const auth = request.headers.get('authorization')
  return auth === `Bearer ${process.env.CRON_SECRET}`
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service   = createServiceClient()
    const now       = new Date()
    const threshold = 7 // days — configurable per workspace in future
    const cutoff    = new Date(now.getTime() - threshold * 86400000).toISOString()

    // Find SOWs awaiting signature past the stall threshold
    const { data: staleSOWs } = await (service as any)
      .from('sow_documents')
      .select('id, project_id, workspace_id, sent_at, projects(id, name, status)')
      .eq('status', 'awaiting_signature')
      .lt('sent_at', cutoff)
      .eq('projects.status', 'Awaiting Signature')

    let stalled = 0
    for (const sow of (staleSOWs || [])) {
      if (!sow.projects) continue
      try {
        await (service as any).from('projects').update({
          status:       'Stalled',
          stall_reason: 'sow_unsigned',
          updated_at:   now.toISOString(),
        }).eq('id', sow.project_id).eq('status', 'Awaiting Signature')

        await (service as any).from('audit_log').insert({
          workspace_id: sow.workspace_id,
          actor_id:     null,
          actor_email:  'cron@scopegov.app',
          actor_name:   'ScopeGov',
          event_type:   'sow.marked_stalled',
          entity_type:  'project',
          entity_id:    sow.project_id,
          entity_name:  sow.projects?.name,
          metadata:     { sow_id: sow.id, days_since_sent: threshold },
        })
        stalled++
      } catch (e) { console.error('SOW stall error:', e) }
    }

    return NextResponse.json({ ok: true, stalled })
  } catch (err) {
    console.error('SOW stall cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}
