export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

function verifyCronSecret(r: NextRequest) {
  return r.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

// Project purge: hard-delete soft-deleted Draft/Intake projects > 30 days
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service  = createServiceClient()
    const cutoff   = new Date(Date.now() - 30 * 86400000).toISOString()

    const { data: purged } = await (service as any)
      .from('projects')
      .delete()
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff)
      .select('id')

    console.log(`[PROJECT PURGE] Hard-deleted ${purged?.length || 0} projects soft-deleted > 30 days ago`)
    return NextResponse.json({ ok: true, purged: purged?.length || 0 })
  } catch (err) {
    console.error('Project purge cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}
