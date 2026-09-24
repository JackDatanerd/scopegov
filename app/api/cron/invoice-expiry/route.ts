export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { renewInvoiceTokenIfExpired } from '@/lib/documents/renew-invoice-token'

import { insertAuditRow } from '@/lib/utils/audit'
import { fetchAll, CronRun } from '@/lib/utils/cron-run'
// FIX (build, cron/portal audit round — flagship finding, section 18):
// see renew-invoice-token.ts for the full history of why this cron exists
// (mirrors app/api/cron/sow-expiry and co-expiry, which exist for the
// identical reason on their own document types) and why it renews rather
// than expires. This is the daily sweep half of that fix — the remind
// route's own defensive renew-on-click is the other half, covering the
// gap between an invoice's token dying and this cron next running.
//
// No notification/email here, unlike sow-expiry/co-expiry: those flip the
// document to a dead-end 'expired' status that requires the agency to
// deliberately start a new version — genuinely actionable, so the team
// gets told. This is a fully self-healing, zero-impact housekeeping
// action (the invoice is still exactly as sent/overdue as before; only
// the bearer token changed) — telling the team every 90 days that a
// token got quietly refreshed would just be notification noise for
// nothing they need to act on. It's still logged to audit_log for
// traceability.
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let service: any
  try {
    service = createServiceClient()
    // FIX (cron/portal audit round 3): moved onto CronRun — see sow-expiry. A renewal that throws used to be
    // console.error'd and skipped while the heartbeat stayed green, so a systematic failure (a bad
    // workspace secret, a schema drift) left every invoice link dying on schedule with no alert.
    const run = new CronRun(service, 'invoice-expiry')
    const now = new Date().toISOString()
    let renewed = 0
    run.result.renewed = 0

    await run.step('renew invoice tokens', async () => {
      // Only invoices actually out with a client can have a dead link — draft has no token yet,
      // paid/void are terminal and don't need one.
      const candidates = await fetchAll<any>('invoice-expiry select', (from, to) =>
        (service as any)
          .from('invoices')
          .select('id, workspace_id, status, expires_at')
          .in('status', ['sent', 'partially_paid', 'overdue'])
          .not('expires_at', 'is', null)
          .lt('expires_at', now)
          .order('id')
          .range(from, to))

      for (const inv of candidates) {
        try {
          const result = await renewInvoiceTokenIfExpired(
            service, inv.id, inv.workspace_id, inv.status, inv.expires_at,
          )
          if (!result.renewed) continue

          await insertAuditRow(service, {
            workspace_id: inv.workspace_id,
            actor_id:     null,
            actor_email:  'cron@scopegov.app',
            actor_name:   'ScopeGov',
            event_type:   'invoice.link_renewed',
            entity_type:  'invoice',
            entity_id:    inv.id,
            entity_name:  null,
            metadata:     { previous_expires_at: inv.expires_at },
          })

          renewed++
        } catch (e) { run.rowError(`invoice ${inv.id} token renewal`, e) }
      }
      run.result.renewed = renewed
    })

    const { body, status } = await run.finish()
    return NextResponse.json(body, { status })
  } catch (err) {
    console.error('Invoice expiry cron error:', err)
    await alertCronFailure(service ?? createServiceClient(), 'invoice-expiry', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET — same aliasing as
// every other cron route here.
export const GET = POST
