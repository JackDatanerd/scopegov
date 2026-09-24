export const runtime = 'nodejs'
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { CronRun } from '@/lib/utils/cron-run'
import { runSigningIntegrity } from '@/lib/documents/signing-integrity'

// Daily. Repairs signed SOWs / accepted change orders whose post-signature steps partly failed (project never
// activated, no payment milestones, no Guardian baseline or address, no amendment) and reports the ones that
// can't be repaired safely. See lib/documents/signing-integrity.ts for the full rationale.
//
// Repairs are idempotent (each checks the state it fixes), so an overlapping run or a retry is harmless.
// A repair that FAILS is a row-level failure: it alerts (cooldown-limited) but the run still records its
// heartbeat, and the same document is retried on the next run. Documents that cannot be repaired
// automatically are reported through the same alert every run they remain inside the 14-day window, so they
// can't be forgotten.
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let service: any
  try {
    service = createServiceClient()
    const run = new CronRun(service, 'signing-integrity')

    await run.step('signing integrity sweep', async () => {
      const report = await runSigningIntegrity(service)
      run.result.sowsChecked = report.sowsChecked
      run.result.cosChecked = report.cosChecked
      run.result.repaired = report.repairs.length
      run.result.repairs = report.repairs.slice(0, 50)
      run.result.unrepairable = report.unrepairable.length
      for (const f of report.failures) run.rowError('repair failed', new Error(f))
      if (report.unrepairable.length) {
        run.rowError('needs a human', new Error(`${report.unrepairable.length} executed document(s) can't be repaired automatically: ${report.unrepairable.slice(0, 10).join(' | ')}`))
      }
    })

    const { body, status } = await run.finish()
    return NextResponse.json(body, { status })
  } catch (err) {
    console.error('Signing integrity cron error:', err)
    await alertCronFailure(service ?? createServiceClient(), 'signing-integrity', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

export const GET = POST
