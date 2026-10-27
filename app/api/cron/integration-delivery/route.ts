export const runtime = 'nodejs'
export const maxDuration = 60

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { CronRun } from '@/lib/utils/cron-run'
import { processDeliveries } from '@/lib/integrations/delivery'

// Drains the integration delivery queue (lib/integrations/delivery.ts). Every minute, via the Cloudflare worker.
//
// A batch is capped at 50 deliveries at 5 in flight with an 8s per-request timeout, so a run finishes well inside
// maxDuration even when every receiver is slow; whatever is left is picked up by the next minute's run.
// A receiver that fails is NOT a cron failure (that is the normal job: it schedules the retry). Only a problem with
// the queue itself — claim/lookup errors — fails the run and pages ops.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient() as any
  try {
    const run = new CronRun(service, 'integration-delivery')
    await run.step('deliver queued events', async () => {
      Object.assign(run.result, await processDeliveries(service, { limit: 50 }))
    })
    const { body, status } = await run.finish()
    return NextResponse.json(body, { status })
  } catch (err) {
    console.error('Integration delivery cron error:', err)
    await alertCronFailure(createServiceClient(), 'integration-delivery', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

export const GET = POST
