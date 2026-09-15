export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'

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
      .select('id, workspace_id, contract_value, currency, retainer_duration_months, created_at, sow_documents(id, status, signed_at)')
      .eq('type', 'retainer')
      .eq('status', 'Active')
      .not('retainer_duration_months', 'is', null)

    let generated = 0
    for (const p of (retainers || [])) {
      try {
        const signedSow = (p.sow_documents || []).find((s: any) => s.status === 'signed')
        if (!signedSow?.signed_at) continue

        const signedDate   = new Date(signedSow.signed_at)
        const monthsSigned = (year - signedDate.getFullYear()) * 12 + (month - (signedDate.getMonth() + 1))

        // Stop generating past retainer duration
        if (monthsSigned >= (p.retainer_duration_months || 12)) continue

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

    return NextResponse.json({ ok: true, generated })
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
