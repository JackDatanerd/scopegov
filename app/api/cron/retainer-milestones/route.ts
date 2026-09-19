export const runtime = 'nodejs'
// FEATURE (cron audit, section 17 — feature gap, closing pass): per-project
// backfill loop (up to `retainer_duration_months` iterations, each with its
// own dedup SELECT) with no pagination across projects — same unbounded
// shape payment-overdue and reconciliation-rollup already carry this
// override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { sendRetainerEndingEmail } from '@/lib/email/templates'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

import { insertAuditRow } from '@/lib/utils/audit'
// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service = createServiceClient()
    const now     = new Date()
    const month   = now.getMonth() + 1
    const year    = now.getFullYear()

    // Active retainer projects within their duration
    const { data: retainers } = await (service as any)
      .from('projects')
      .select('id, workspace_id, name, contract_value, currency, retainer_duration_months, created_at, sow_documents(id, status, signed_at), clients(name)')
      .eq('type', 'retainer')
      .eq('status', 'Active')
      .not('retainer_duration_months', 'is', null)

    let generated = 0
    let endedNotified = 0
    for (const p of (retainers || [])) {
      try {
        const signedSow = (p.sow_documents || []).find((s: any) => s.status === 'signed')
        if (!signedSow?.signed_at) continue

        const signedDate   = new Date(signedSow.signed_at)
        const monthsSigned = (year - signedDate.getFullYear()) * 12 + (month - (signedDate.getMonth() + 1))

        // Stop generating past retainer duration
        if (monthsSigned >= (p.retainer_duration_months || 12)) {
          // FEATURE (cron audit, section 17): this used to just stop
          // generating milestones with zero signal to the team — the exact
          // "let something go silently stale" gap this product's other
          // stall crons (approval/co/sow) all exist to prevent, just
          // applied to its own billing engine instead of a client
          // interaction. Notify once, the moment the retainer's final
          // milestone month has passed, so the team knows to renew or
          // wind the contract down rather than discovering it later from
          // an invoice that never got generated.
          const { data: alreadyNotified } = await (service as any)
            .from('audit_log').select('id')
            .eq('workspace_id', p.workspace_id).eq('event_type', 'retainer.ended')
            .eq('entity_id', p.id).limit(1).maybeSingle()
          if (alreadyNotified) continue

          await insertAuditRow(service, {
            workspace_id: p.workspace_id, actor_id: null,
            actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
            event_type: 'retainer.ended', entity_type: 'project',
            entity_id: p.id, entity_name: p.name,
            metadata: { duration_months: p.retainer_duration_months, months_completed: monthsSigned },
          })

          await notifyMembersWithPermission(service, {
            workspaceId: p.workspace_id, permission: 'VIEW_FINANCIALS', eventType: 'retainer_ending',
            type: 'retainer_ending', title: `Retainer term ended — ${p.name}`,
            body: `The ${p.retainer_duration_months}-month retainer for ${p.clients?.name || 'this client'} on ${p.name} has run its course. No further monthly milestones will be generated.`,
            entityType: 'project', entityId: p.id, projectId: p.id,
          })

          try {
            const emails = await getMemberEmailsWithPermission(service, p.workspace_id, 'VIEW_FINANCIALS', 10, 'retainer_ending', p.id)
            if (emails.length) {
              await sendRetainerEndingEmail({
                to: emails,
                clientName: p.clients?.name || 'Client',
                projectName: p.name,
                durationMonths: p.retainer_duration_months,
                projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${p.id}?tab=billing`,
              })
            }
          } catch (e) { console.error('Retainer ending email failed:', e) }

          endedNotified++
          continue
        }

        // FIX (build, cron/portal audit round): this used to only ever
        // generate the CURRENT month's milestone. Every other cron in
        // this directory is heavily guarded against silently losing work
        // (races, timeouts, partial failures) — this one wasn't: if the
        // cron didn't run for a stretch (a bad deploy, an outage), that
        // month's milestone was gone forever, with nothing else ever
        // looking backward to catch it up. That's silent under-billing,
        // exactly the kind of "let something go stale with zero signal"
        // gap the ended-retainer notification just above exists to
        // prevent, just for a skipped month instead of a finished
        // contract. Loop over every month from signing through the
        // current one (capped at the retainer's duration) instead of just
        // "this month" — the existing per-month dedup check below means
        // already-generated months are simply skipped, so this only ever
        // fills genuine gaps, never duplicates.
        const monthsToGenerate = Math.min(monthsSigned, (p.retainer_duration_months || 12) - 1)
        for (let i = 0; i <= monthsToGenerate; i++) {
          const targetDate  = new Date(signedDate.getFullYear(), signedDate.getMonth() + i, 1)
          const targetYear  = targetDate.getFullYear()
          const targetMonth = targetDate.getMonth() + 1
          const monthKey    = `${targetYear}-${String(targetMonth).padStart(2, '0')}`
          const dueDate     = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`

          // FIX (re-audit, cron section): the old check searched for
          // monthKey ("2026-12") *inside the title string*, but the title
          // is generated below as "Monthly retainer — December 2026" — a
          // completely different format with zero textual overlap. That
          // `.like()` could never match, so this dedup check silently
          // never worked: any re-run in the same month (retry, redeploy,
          // manual trigger) created a second real-money milestone, and
          // `.single()` on a lookup that could match 0+ rows compounded
          // it further by erroring (not throwing — supabase-js returns an
          // error object, which was also never checked) instead of ever
          // returning `null` cleanly. due_date is always set
          // deterministically to the 1st of the target month by this same
          // function, so matching on it (alongside project + type) is an
          // exact, format-independent key — and now also the key that
          // makes the backfill loop above safe to re-run every day.
          const { data: existing, error: existingErr } = await (service as any)
            .from('payment_milestones')
            .select('id')
            .eq('project_id', p.id)
            .eq('type', 'retainer_monthly')
            .eq('due_date', dueDate)

          if (existingErr) { console.error('Retainer milestone dedup check failed for project:', p.id, existingErr); continue }
          if (existing?.length) continue

          const monthLabel = targetDate.toLocaleString('en-US', { month: 'long', year: 'numeric' })

          await (service as any).from('payment_milestones').insert({
            project_id:   p.id,
            sow_id:       signedSow.id,
            title:        `Monthly retainer — ${monthLabel}`,
            type:         'retainer_monthly',
            amount:       p.contract_value || 0,
            percentage:   null,
            trigger:      `Monthly retainer payment — ${monthLabel}`,
            tax_rate:     0,
            tax_inclusive: false,
            due_date:     dueDate,
            status:       'pending',
          })

          await insertAuditRow(service, {
            workspace_id: p.workspace_id,
            actor_id:     null,
            actor_email:  'cron@scopegov.app',
            actor_name:   'ScopeGov',
            event_type:   'payment.milestone_generated',
            entity_type:  'project',
            entity_id:    p.id,
            entity_name:  monthLabel,
            metadata:     { month: monthKey, amount: p.contract_value, backfilled: monthKey !== `${year}-${String(month).padStart(2, '0')}` },
          })
          generated++
        }
      } catch (e) { console.error('Retainer milestone error for project:', p.id, e) }
    }

    await recordCronHeartbeat(service, 'retainer-milestones', { generated, endedNotified })
    return NextResponse.json({ ok: true, generated, endedNotified })
  } catch (err) {
    console.error('Retainer milestone cron error:', err)
    await alertCronFailure(createServiceClient(), 'retainer-milestones', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. Exporting GET as an alias makes both invocation paths work.
//
// FIX (build, cron/portal audit round): the 3 sub-hourly jobs (sow-stall,
// co-stall, guardian-health) are now scheduled directly in vercel.json
// AND kept in .github/workflows/vercel-crons.yml as a redundant trigger
// (see that file's own comment for why both are kept intentionally) —
// this comment previously implied GitHub Actions was the only path,
// which stopped being true once vercel.json picked these three up too.
export const GET = POST
