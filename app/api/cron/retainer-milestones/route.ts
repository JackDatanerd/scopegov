export const runtime = 'nodejs'
// Per-project backfill loop with no pagination across projects — same unbounded shape
// payment-overdue and reconciliation-rollup carry this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { sendRetainerEndingEmail } from '@/lib/email/templates'
import { insertAuditRow } from '@/lib/utils/audit'
import { CronRun, fetchAll } from '@/lib/utils/cron-run'

// Daily. Generates one 'retainer_monthly' payment milestone per month for every Active retainer,
// and tells the team once when a retainer's term has run out.
//
// FEATURE (cron/portal audit round 3): OPEN-ENDED retainers. retainer_duration_months is optional (the
// new-project form lets the field be cleared, parseRetainerMonths accepts blank -> NULL), but this cron used to
// select only `retainer_duration_months IS NOT NULL` — so a retainer created with no term got exactly ONE milestone
// (the signing month's, from the sign route) and was then never billed again, with nothing anywhere saying so.
// A NULL term now means "open-ended": one milestone per month until the project is completed or archived, and no
// "term ended" announcement. Deliberately NO historical backfill for them: retainers that were silently unbilled
// before this shipped would otherwise get every missed month since signing generated at once, all instantly
// overdue and paged to finance — for months the agency very likely invoiced by hand. Open-ended billing starts
// at the current month; a month is only ever missed if the cron is down across a whole month boundary AND the
// following month's run is also missed, which the watchdog pages on long before.
//
// All date arithmetic is UTC (the sign route stamps signed_at in UTC; mixing in the server's local
// zone made "which month is this" depend on where the function happened to run).
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const run = new CronRun(service, 'retainer-milestones')
  let generated = 0, endedNotified = 0, skippedNoValue = 0

  await run.step('generate retainer milestones', async () => {
    const now   = new Date()
    const month = now.getUTCMonth() + 1
    const year  = now.getUTCFullYear()
    const currentKey = `${year}-${String(month).padStart(2, '0')}`

    const retainers = await fetchAll<any>('retainer-milestones select', (from, to) =>
      (service as any)
        .from('projects')
        .select('id, workspace_id, name, contract_value, currency, retainer_duration_months, created_at, sow_documents(id, status, signed_at), clients(name)')
        .eq('type', 'retainer')
        .eq('status', 'Active')
        .is('deleted_at', null)
        .order('id')
        .range(from, to))

    for (const p of retainers) {
      try {
        const signedSow = (p.sow_documents || []).find((s: any) => s.status === 'signed')
        if (!signedSow?.signed_at) continue

        // null = open-ended (see the header). `|| 12` is gone: a stored 0 can't happen (parseRetainerMonths
        // enforces 1..60), and it silently invented a 12-month term for anything falsy.
        const duration: number | null = p.retainer_duration_months != null ? Number(p.retainer_duration_months) : null
        const openEnded    = duration == null
        const signedDate   = new Date(signedSow.signed_at)
        const signedYear   = signedDate.getUTCFullYear()
        const signedMonth0 = signedDate.getUTCMonth()
        const monthsSigned = (year - signedYear) * 12 + (month - (signedMonth0 + 1))

        // ── 1. Generate (and backfill) milestones ─────────────────────────────────────────
        // Runs BEFORE the "term ended" check. It used to sit after it, behind a `continue`, so a
        // retainer whose final month(s) were missed (cron outage, or the project not being
        // Active) went straight to "ended" and the missing months were never billed.
        // Every month from signing through min(current month, last term month) is a candidate;
        // months that already exist are skipped, so this only ever fills genuine gaps.
        if (!(Number(p.contract_value) > 0)) {
          // A zero/NULL contract value used to produce zero-dollar "milestones" (and a
          // payment.milestone_generated audit row for each). Nothing billable to generate.
          skippedNoValue++
        } else {
          // ONE query for the project's existing retainer months. A month counts as present if any
          // retainer_monthly row has a due_date inside it: the sign route stamps the signing month's
          // row with the signing DAY, the cron stamps the 1st, and matching on the exact date let the
          // two disagree (a second full-amount row for the same month).
          const { data: existingRows, error: existingErr } = await (service as any)
            .from('payment_milestones').select('due_date')
            .eq('project_id', p.id).eq('type', 'retainer_monthly')
          if (existingErr) throw new Error(`existing milestones lookup: ${existingErr.message}`)
          const have = new Set<string>((existingRows || []).filter((r: any) => r.due_date).map((r: any) => String(r.due_date).slice(0, 7)))

          const lastIndex  = openEnded ? monthsSigned : Math.min(monthsSigned, (duration as number) - 1)
          const firstIndex = openEnded ? Math.max(0, monthsSigned) : 0 // open-ended: current month forward, no backfill
          for (let i = firstIndex; i <= lastIndex; i++) {
            const target      = new Date(Date.UTC(signedYear, signedMonth0 + i, 1))
            const targetYear  = target.getUTCFullYear()
            const targetMonth = target.getUTCMonth() + 1
            const monthKey    = `${targetYear}-${String(targetMonth).padStart(2, '0')}`
            if (have.has(monthKey)) continue
            const dueDate    = `${monthKey}-01`
            const monthLabel = target.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

            // The insert's result used to be ignored: a failed insert still wrote a
            // "payment.milestone_generated" audit row and bumped the counter. Migration 063 adds a
            // unique index per (project, month) — 23505 means another run/signing got there first.
            const { error: insErr } = await (service as any).from('payment_milestones').insert({
              project_id:   p.id,
              sow_id:       signedSow.id,
              title:        `Monthly retainer — ${monthLabel}`,
              type:         'retainer_monthly',
              amount:       p.contract_value,
              percentage:   null,
              trigger:      `Monthly retainer payment — ${monthLabel}`,
              tax_rate:     0,
              tax_inclusive: false,
              due_date:     dueDate,
              status:       'pending',
            })
            if (insErr) {
              if ((insErr as any).code === '23505') continue
              throw new Error(`insert ${monthKey}: ${insErr.message}`)
            }

            await insertAuditRow(service, {
              workspace_id: p.workspace_id, actor_id: null,
              actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
              event_type: 'payment.milestone_generated', entity_type: 'project',
              entity_id: p.id, entity_name: monthLabel,
              metadata: { month: monthKey, amount: p.contract_value, backfilled: monthKey !== currentKey, ...(openEnded ? { open_ended: true } : {}) },
            })
            generated++
          }
        }

        // ── 2. Term ended → tell the team once per term ───────────────────────────────────
        if (!openEnded && monthsSigned >= (duration as number)) {
          const termMonths = duration as number
          // Dedup is per TERM LENGTH, not per project: when a retainer is extended (renewal CO or a
          // manual edit) and later runs out again, that second ending must be announced too. The old
          // (workspace, event, project) key found the first ending's audit row and stayed silent.
          const { data: alreadyNotified, error: dedupErr } = await (service as any)
            .from('audit_log').select('id')
            .eq('workspace_id', p.workspace_id).eq('event_type', 'retainer.ended')
            .eq('entity_id', p.id).eq('metadata->>duration_months', String(termMonths))
            .limit(1).maybeSingle()
          if (dedupErr) throw new Error(`retainer.ended dedup lookup: ${dedupErr.message}`)
          if (alreadyNotified) continue

          // The audit row IS the dedup marker, so it must land before anyone is told. If it can't be
          // written, skip and retry tomorrow — the old code notified anyway and then re-notified on
          // every daily run while audit_log kept failing.
          const marked = await insertAuditRow(service, {
            workspace_id: p.workspace_id, actor_id: null,
            actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
            event_type: 'retainer.ended', entity_type: 'project',
            entity_id: p.id, entity_name: p.name,
            metadata: { duration_months: termMonths, months_completed: monthsSigned },
          })
          if (!marked) throw new Error(`could not record retainer.ended for project ${p.id}`)

          await notifyMembersWithPermission(service, {
            workspaceId: p.workspace_id, permission: 'VIEW_FINANCIALS', eventType: 'retainer_ending',
            type: 'retainer_ending', title: `Retainer term ended — ${p.name}`,
            body: `The ${termMonths}-month retainer for ${p.clients?.name || 'this client'} on ${p.name} has run its course. No further monthly milestones will be generated unless the term is extended (a retainer-renewal change order extends it automatically).`,
            entityType: 'project', entityId: p.id, projectId: p.id,
          })

          try {
            const emails = await getMemberEmailsWithPermission(service, p.workspace_id, 'VIEW_FINANCIALS', 10, 'retainer_ending', p.id)
            if (emails.length) {
              await sendRetainerEndingEmail({
                to: emails,
                clientName: p.clients?.name || 'Client',
                projectName: p.name,
                durationMonths: termMonths,
                projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${p.id}?tab=billing`,
              })
            }
          } catch (e) { console.error('Retainer ending email failed:', e) }

          endedNotified++
        }
      } catch (e) { run.rowError(`retainer ${p.id}`, e) }
    }
    Object.assign(run.result, { generated, endedNotified, skippedNoValue })
  })

  const { body, status } = await run.finish()
  return NextResponse.json(body, { status })
}

// Vercel Cron invokes the configured path with GET; the GitHub Actions backup uses POST.
export const GET = POST
