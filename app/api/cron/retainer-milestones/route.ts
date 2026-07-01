export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

function verifyCronSecret(r: NextRequest) {
  return r.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

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

        // Check if milestone already exists for this month
        const monthKey = `${year}-${String(month).padStart(2, '0')}`
        const { data: existing } = await (service as any)
          .from('payment_milestones')
          .select('id')
          .eq('project_id', p.id)
          .eq('type', 'retainer_monthly')
          .like('title', `%${monthKey}%`)
          .single()

        if (existing) continue

        const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
        const dueDate    = `${year}-${String(month).padStart(2, '0')}-01`

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
