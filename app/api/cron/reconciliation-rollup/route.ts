export const runtime = 'nodejs'
// FEATURE (cron audit, section 17): this loops every non-archived project
// across every workspace, doing 3 DB round-trips per project (now 1 batch
// of 3 run in parallel — see below), with no pagination or maxDuration
// override anywhere in this route or in vercel.json. As project count
// grows this risks hitting Vercel's default function timeout, which kills
// the loop mid-way with no catchable error — that day's snapshot for
// whatever project wasn't reached yet is just silently missing. 300s is
// the max duration available without Fluid Compute; if project volume
// ever outgrows that too, this needs real batching (chunk projects, one
// invocation per chunk) rather than a bigger number here.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

// Phase 4 — daily rollup writing one contract_reconciliation_snapshots row
// per (project, day). Snapshotting rather than live-computing on every
// dashboard/report load is deliberate: guardian_flags/exceptions_log/
// invoices are event-level tables, not time-series, so a trend chart needs
// point-in-time snapshots rather than an expensive on-the-fly aggregation
// across every project on every page load (same rationale as Phase 2's
// scope_health_snapshots).
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    const today = new Date().toISOString().split('T')[0]

    const { data: projects, error: projErr } = await (service as any)
      .from('projects')
      .select('id, workspace_id, contract_value, status')
      // FIX (re-audit, cron section): projects.status is the project_status
      // enum ('Draft'|'Intake'|'Awaiting Signature'|'Changes Requested'|
      // 'Active'|'Stalled'|'Complete'|'Archived') — capital A. 'archived'
      // (lowercase) isn't a valid enum literal, so Postgres rejected the
      // cast with "invalid input value for enum project_status" on every
      // single run. The route's own catch block turned that into a 500,
      // meaning contract_reconciliation_snapshots was never written —
      // silently emptying the reconciliation trend chart on the project
      // detail page, invoices page, and invoice PDFs. (clients.status uses
      // lowercase 'active'/'archived' — this was very likely copied from
      // that table's convention by mistake.)
      //
      // FIX (deep audit, section 17 follow-up): this never excluded a
      // soft-deleted project. A Draft/Intake project can be soft-deleted
      // (see api/projects/[id]/route.ts's DELETE handler) without its
      // status ever changing away from 'Draft'/'Intake', so it kept
      // matching this `.neq('status','Archived')` filter and getting a
      // daily reconciliation snapshot written for it indefinitely —
      // scope-health-rollup already excludes deleted projects the same
      // way this route now does.
      .is('deleted_at', null)
      .neq('status', 'Archived')

    if (projErr) {
      console.error('Reconciliation rollup: project fetch failed', projErr)
      return NextResponse.json({ error: 'Failed to load projects' }, { status: 500 })
    }

    let written = 0
    for (const project of (projects || [])) {
      try {
        // FIX (cron audit, section 17): these 3 queries used to run one
        // after another (3 sequential round-trips per project); they don't
        // depend on each other, so running them concurrently cuts this
        // loop's wall-clock time roughly 3x — meaningful given there's no
        // pagination and this runs across every project in every workspace.
        const [amendmentsRes, invoicesRes, openCosRes] = await Promise.all([
          // Contracted value: base contract + accepted amendments. Mirrors
          // the exact effectiveContractValue calc used on the project detail
          // page (BUG-053: amendments.financial_impact already excludes
          // exceptions_log, so this doesn't need to filter that separately).
          (service as any).from('amendments').select('financial_impact').eq('project_id', project.id),
          // Invoiced / paid to date — only invoices that were ever actually
          // sent count (draft has nothing sent yet; void was withdrawn).
          // amount_paid is the trigger-maintained running total from
          // invoice_payments (004_invoicing.sql), so summing it here is
          // equivalent to summing invoice_payments directly but cheaper.
          // FIX (fix round, section-12 flagship finding): now also selects
          // `subtotal` — see the invoicedToDate fix below.
          (service as any).from('invoices').select('amount, amount_paid, subtotal, status').eq('project_id', project.id),
          // At-risk: change orders sent to the client but not yet accepted —
          // same "at risk (pending COs)" definition already shown on the
          // project overview page, rolled here so it's comparable over time.
          (service as any).from('change_orders').select('total').eq('project_id', project.id)
            .in('status', ['awaiting_response', 'countered']),
        ])

        const amendmentTotal = (amendmentsRes.data || []).reduce((s: number, a: any) => s + (a.financial_impact || 0), 0)
        const contractedValue = (project.contract_value || 0) + amendmentTotal

        const billedInvoices = (invoicesRes.data || []).filter((i: any) => !['draft', 'void'].includes(i.status))
        // FIX (fix round, section-12 flagship finding): this summed
        // `amount` — the invoice's tax-INCLUSIVE grand total — against
        // `contractedValue` above, which is purely pre-tax (contract_value
        // + amendments; tax is never part of what a milestone/SOW/CO was
        // originally scoped or accepted for — see migration 023's and the
        // invoice-creation route's own reasoning for why this codebase is
        // otherwise careful to keep the two separate). For any taxed
        // invoice, that meant a contract billed out to exactly 100% would
        // show invoiced_to_date > contracted_value with nothing to explain
        // the gap — visible on the client's own portal page, every invoice
        // PDF, and this workspace's own Invoices page portfolio strip.
        // amount_paid correctly stays post-tax below (it's real cash the
        // client actually paid, tax included) — only invoicedToDate was
        // using the wrong figure. Falls back to `amount` only for a
        // pre-migration-014 row somehow missing a backfilled subtotal.
        const invoicedToDate = billedInvoices.reduce((s: number, i: any) => s + (i.subtotal ?? i.amount ?? 0), 0)
        const paidToDate     = billedInvoices.reduce((s: number, i: any) => s + (i.amount_paid || 0), 0)

        const atRiskValue = (openCosRes.data || []).reduce((s: number, c: any) => s + (c.total || 0), 0)

        const { error: upsertErr } = await (service as any)
          .from('contract_reconciliation_snapshots')
          .upsert({
            workspace_id:     project.workspace_id,
            project_id:       project.id,
            contracted_value: contractedValue,
            invoiced_to_date: invoicedToDate,
            paid_to_date:     paidToDate,
            at_risk_value:    atRiskValue,
            snapshot_date:    today,
          }, { onConflict: 'project_id,snapshot_date' })

        if (upsertErr) {
          console.error('Reconciliation rollup: upsert failed', project.id, upsertErr)
          continue
        }
        written++
      } catch (e) { console.error('Reconciliation rollup: project error', project.id, e) }
    }

    await recordCronHeartbeat(service, 'reconciliation-rollup', { projectsProcessed: projects?.length || 0, snapshotsWritten: written })
    return NextResponse.json({ ok: true, projectsProcessed: projects?.length || 0, snapshotsWritten: written })
  } catch (err) {
    console.error('Reconciliation rollup cron error:', err)
    await alertCronFailure(createServiceClient(), 'reconciliation-rollup', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// Vercel Cron Jobs invoke via GET; alias same as every other cron route here.
export const GET = POST
