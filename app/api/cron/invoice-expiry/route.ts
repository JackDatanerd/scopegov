export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { renewInvoiceTokenIfExpired } from '@/lib/documents/renew-invoice-token'

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

  try {
    const service = createServiceClient()
    const now     = new Date().toISOString()

    // Only invoices actually out with a client can have a dead link —
    // draft has no token yet, paid/void are terminal and don't need one.
    const { data: candidates } = await (service as any)
      .from('invoices')
      .select('id, workspace_id, status, expires_at')
      .in('status', ['sent', 'partially_paid', 'overdue'])
      .not('expires_at', 'is', null)
      .lt('expires_at', now)

    let renewed = 0
    for (const inv of (candidates || [])) {
      try {
        const result = await renewInvoiceTokenIfExpired(
          service, inv.id, inv.workspace_id, inv.status, inv.expires_at,
        )
        if (!result.renewed) continue

        await (service as any).from('audit_log').insert({
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
      } catch (e) { console.error('Invoice token renewal error:', e) }
    }

    return NextResponse.json({ ok: true, renewed })
  } catch (err) {
    console.error('Invoice expiry cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET — same aliasing as
// every other cron route here.
export const GET = POST
