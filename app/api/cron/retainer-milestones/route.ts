export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { sendRetainerEndingEmail } from '@/lib/email/templates'

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

          await (service as any).from('audit_log').insert({
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

        const monthKey   = `${year}-${String(month).padStart(2, '0')}`
        const dueDate    = `${year}-${String(month).padStart(2, '0')}-01`

        // FIX (re-audit, cron section): the old check searched for
        // monthKey ("2026-12") *inside the title string*, but the title
        // is generated below as "Monthly retainer — December 2026" — a
        // completely different format with zero textual overlap. That
        // `.like()` could never match, so this dedup check silently never
        // worked: any re-run in the same month (retry, redeploy, manual
        // trigger) created a second real-money milestone, and `.single()`
        // on a lookup that could match 0+ rows compounded it further by
        // erroring (not throwing — supabase-js returns an error object,
        // which was also never checked) instead of ever returning `null`
        // cleanly. due_date is always set deterministically to the 1st of
        // the target month by this same function, so matching on it
        // (alongside project + type) is an exact, format-independent key.
        const { data: existing, error: existingErr } = await (service as any)
          .from('payment_milestones')
          .select('id')
          .eq('project_id', p.id)
          .eq('type', 'retainer_monthly')
          .eq('due_date', dueDate)

        if (existingErr) { console.error('Retainer milestone dedup check failed for project:', p.id, existingErr); continue }
        if (existing?.length) continue

        const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })

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

        await (service as any).from('audit_log').insert({
          workspace_id: p.workspace_id,
          actor_id:     null,
          actor_email:  'cron@scopegov.app',
          actor_name:   'ScopeGov',
          event_type:   'payment.milestone_generated',
          entity_type:  'project',
          entity_id:    p.id,
          entity_name:  monthLabel,
          metadata:     { month: monthKey, amount: p.contract_value },
        })
        generated++
      } catch (e) { console.error('Retainer milestone error for project:', p.id, e) }
    }

    return NextResponse.json({ ok: true, generated, endedNotified })
  } catch (err) {
    console.error('Retainer milestone cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. The 3 sub-hourly jobs (sow-stall, co-stall, guardian-health) are
// triggered by the GitHub Actions workflow via POST, which still works.
// Exporting GET as an alias makes both invocation paths work.
export const GET = POST
