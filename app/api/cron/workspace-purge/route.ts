export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

function verifyCronSecret(r: NextRequest) {
  return r.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service  = createServiceClient()
  const cutoff7yr = new Date(Date.now() - 7 * 365 * 86400000).toISOString()

  const { data: purged } = await (service as any)
    .from('workspaces')
    .delete()
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff7yr)
    .select('id')

  console.log(`[WORKSPACE PURGE] Hard-deleted ${purged?.length || 0} workspaces older than 7 years`)
  return NextResponse.json({ ok: true, purged: purged?.length || 0 })
}
