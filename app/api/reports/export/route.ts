export const runtime = 'nodejs'

// app/api/reports/export/route.ts
//   ?mode=scope|financial   (default scope — same two tabs as the dashboard)
//   &format=csv|pdf         (default csv)
//   &period=30d|90d|6m|12m|all
//   &currency=XXX
//
// FEATURE (deep audit, Reports & Audit re-pass): the Reports page (Scope
// protection + Financial overview) never had an export path. The audit log
// (api/reports/audit-export) and the Portfolio dashboard
// (api/reports/portfolio/export) both already offer CSV and PDF for
// exactly this reason — a workspace-wide rollup is the thing an agency
// principal most wants to hand to someone who doesn't have a login. Same
// permission gate as the dashboard itself: VIEW_ALL_PROJECTS for scope
// mode, plus VIEW_FINANCIALS for financial mode — exporting is a stricter
// form of the same read, not a separate capability, matching every other
// export route's reasoning in this codebase.

import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { periodSince, PERIOD_LABELS, getScopeReportData, getFinancialReportData } from '@/lib/reports/scope-financial-data'
import { renderScopeReportPdf, renderFinancialReportPdf } from '@/lib/pdf/reports-report'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_ALL_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_ALL_PROJECTS' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const mode   = (searchParams.get('mode') || 'scope') as 'scope' | 'financial'
    const format = (searchParams.get('format') || 'csv') as 'csv' | 'pdf'
    const period = searchParams.get('period') || '90d'
    const requestedCurrency = searchParams.get('currency')
    if (!['scope', 'financial'].includes(mode))
      return NextResponse.json({ error: 'Unsupported mode' }, { status: 400 })
    if (!['csv', 'pdf'].includes(format))
      return NextResponse.json({ error: 'Unsupported format' }, { status: 400 })

    const canSeeFinancials = hasPermission(session, 'VIEW_FINANCIALS')
    if (mode === 'financial' && !canSeeFinancials)
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })

    const service = createServiceClient()
    const since = periodSince(period)
    const data = mode === 'scope'
      ? await getScopeReportData(service, session.workspaceId, since, requestedCurrency, canSeeFinancials)
      : await getFinancialReportData(service, session.workspaceId, since, requestedCurrency)

    // Same reasoning as audit_log.exported / portfolio.exported — who
    // pulled a contract-value or scope-governance rollup, and when, is
    // itself something a compliance trail should capture.
    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'reports.exported',
      entityType: 'workspace', entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { mode, format, period, currency: data.currency },
    })

    const filenameBase = filenameSlug(session.workspaceName, mode, period)

    if (format === 'csv') {
      const csv = mode === 'scope' ? scopeToCsv(data) : financialToCsv(data)
      return new NextResponse(new Uint8Array(Buffer.from(csv, 'utf-8')), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filenameBase}.csv"`,
        },
      })
    }

    const meta = {
      agencyName: session.agencyName, workspaceName: session.workspaceName,
      generatedBy: session.name, generatedAt: new Date().toISOString(),
      periodLabel: PERIOD_LABELS[period] || PERIOD_LABELS['90d'],
    }
    const buffer = mode === 'scope' ? await renderScopeReportPdf(meta, data) : await renderFinancialReportPdf(meta, data)
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filenameBase}.pdf"`,
      },
    })
  } catch (err) {
    console.error('Reports export error:', err)
    return NextResponse.json({ error: 'Could not generate export' }, { status: 500 })
  }
}

function filenameSlug(workspaceName: string, mode: string, period: string): string {
  const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace'
  const date = new Date().toISOString().slice(0, 10)
  return `${slug}-${mode}-report-${period}-${date}`
}

// Same CSV-formula-injection guard as api/reports/audit-export/route.ts and
// api/reports/portfolio/export/route.ts — project/client/deliverable names
// in this export are user-supplied strings.
function csvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@]/.test(str)) str = `'${str}`
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function scopeToCsv(data: any): string {
  const lines: string[] = []
  const m = data.metrics

  lines.push('Scope protection summary')
  lines.push(['Metric', 'Value'].map(csvCell).join(','))
  lines.push(['Flags raised', m.total_flags ?? 0].map(csvCell).join(','))
  lines.push(['Converted to CO', m.converted_to_co ?? 0].map(csvCell).join(','))
  lines.push(['Recovered value', m.recovered_value ?? 'redacted'].map(csvCell).join(','))
  lines.push(['Currency', data.currency].map(csvCell).join(','))
  lines.push('')

  lines.push(`Flags by project (${(data.flagsByProject || []).length})`)
  lines.push(['Project', 'Flag count'].map(csvCell).join(','))
  for (const p of (data.flagsByProject || [])) {
    lines.push([p.project_name, p.flag_count].map(csvCell).join(','))
  }
  lines.push('')

  lines.push(`Exceptions granted (${(data.exceptionsByProject || []).length})`)
  lines.push(['Deliverable', 'Project', 'Estimated value'].map(csvCell).join(','))
  for (const e of (data.exceptionsByProject || [])) {
    lines.push([e.deliverable, e.projects?.name || '', e.estimated_value ?? 'redacted'].map(csvCell).join(','))
  }
  lines.push('')

  lines.push(`Scope adjustments (${(data.adjustments || []).length})`)
  lines.push(['Project', 'Old value', 'New value', 'Reason', 'Date'].map(csvCell).join(','))
  for (const a of (data.adjustments || [])) {
    lines.push([a.projects?.name || '', a.old_value, a.new_value, a.reason, new Date(a.adjusted_at).toISOString()].map(csvCell).join(','))
  }

  return lines.join('\r\n')
}

function financialToCsv(data: any): string {
  const lines: string[] = []
  const m = data.metrics

  lines.push('Financial overview summary')
  lines.push(['Metric', 'Value'].map(csvCell).join(','))
  lines.push(['Effective contract value', m.effective_value ?? 0].map(csvCell).join(','))
  lines.push(['CO impact', m.co_impact ?? 0].map(csvCell).join(','))
  lines.push(['COs raised', m.cos_raised ?? 0].map(csvCell).join(','))
  lines.push(['COs accepted', m.cos_accepted ?? 0].map(csvCell).join(','))
  lines.push(['Currency', data.currency].map(csvCell).join(','))
  lines.push('')

  lines.push(`Revenue by client (${(data.byClient || []).length})`)
  lines.push(['Client', 'Value'].map(csvCell).join(','))
  for (const c of (data.byClient || [])) {
    lines.push([c.client_name, c.value].map(csvCell).join(','))
  }
  lines.push('')

  lines.push(`Revenue by project type (${(data.byType || []).length})`)
  lines.push(['Type', 'Value'].map(csvCell).join(','))
  for (const t of (data.byType || [])) {
    lines.push([t.type_label, t.value].map(csvCell).join(','))
  }
  lines.push('')

  if (data.coGrid) {
    lines.push('Change order impact grid')
    lines.push(['Raised', 'Accepted', 'Declined', 'Pending'].map(csvCell).join(','))
    lines.push([data.coGrid.raised, data.coGrid.accepted, data.coGrid.declined, data.coGrid.pending].map(csvCell).join(','))
  }

  return lines.join('\r\n')
}
