export const runtime = 'nodejs'
export const maxDuration = 60

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

import { getWorkspaceTimeZone } from '@/lib/utils/workspace-time'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { getScopeReportData, getFinancialReportData } from '@/lib/reports/scope-financial-data'
import { parsePeriod, periodSince, PERIOD_LABELS } from '@/lib/reports/period'
import { csvCell, CSV_BOM } from '@/lib/utils/csv'
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
    // Allowlisted (see lib/reports/period.ts): an unknown period used to
    // export ALL-TIME data under a "Last 90 days" PDF heading and write the
    // raw string into the filename and the audit metadata.
    const period = parsePeriod(searchParams.get('period'))
    const currencyParam = searchParams.get('currency')
    const requestedCurrency = currencyParam && /^[A-Za-z]{3}$/.test(currencyParam) ? currencyParam.toUpperCase() : null
    if (!['scope', 'financial'].includes(mode))
      return NextResponse.json({ error: 'Unsupported mode' }, { status: 400 })
    if (!['csv', 'pdf'].includes(format))
      return NextResponse.json({ error: 'Unsupported format' }, { status: 400 })
    if (!period)
      return NextResponse.json({ error: 'Invalid period' }, { status: 400 })

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
    const logExport = () => logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'reports.exported',
      entityType: 'workspace', entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { mode, format, period, currency: data.currency, truncated: data.truncated },
    })

    const filenameBase = filenameSlug(session.workspaceSlug, session.workspaceName, mode, period)

    if (format === 'csv') {
      const csv = mode === 'scope' ? scopeToCsv(data) : financialToCsv(data)
      await logExport()
      return new NextResponse(new Uint8Array(Buffer.from(CSV_BOM + csv, 'utf-8')), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filenameBase}.csv"`,
        },
      })
    }

    const meta = {
      agencyName: session.agencyName, workspaceName: session.workspaceName,
      generatedBy: session.name, generatedAt: new Date().toISOString(),
      timeZone: await getWorkspaceTimeZone(service, session.workspaceId),
      periodLabel: PERIOD_LABELS[period],
    }
    const buffer = mode === 'scope' ? await renderScopeReportPdf(meta, data) : await renderFinancialReportPdf(meta, data)
    await logExport()
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

function filenameSlug(workspaceSlug: string, workspaceName: string, mode: string, period: string): string {
  // FIX (deep audit, Settings independent re-pass — feature gap): this used
  // to re-derive its own throwaway slug from the workspace NAME on every
  // export, duplicated three times across this route and its two siblings
  // (audit-export, portfolio/export) — and none of the three agreed with
  // each other on a stable identifier if the agency ever renamed itself.
  // workspaces.slug (session.workspaceSlug) is the one the app actually
  // treats as canonical now (see workspace/settings/route.ts's slug case),
  // so use it directly; only fall back to re-deriving one from the name for
  // a session predating that column being populated everywhere (there
  // shouldn't be any, since it's NOT NULL, but this keeps a bad/empty value
  // from ever producing an empty filename rather than throwing).
  const slug = (workspaceSlug || '').trim()
    || workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    || 'workspace'
  const date = new Date().toISOString().slice(0, 10)
  return `${slug}-${mode}-report-${period}-${date}`
}

function scopeToCsv(data: any): string {
  const lines: string[] = []
  const m = data.metrics

  // FIX (deep audit, Reports & Audit re-pass — CRITICAL): see
  // lib/reports/scope-financial-data.ts's `truncated` comment. Same
  // single-cell note-line convention already used by
  // api/reports/audit-export/route.ts's toCsv.
  if (data.truncated) {
    lines.push(csvCell('This export is based on a large volume of data for the selected period and may be undercounting some figures. Narrow the date range for a fully accurate total.'))
  }

  lines.push('Scope protection summary')
  lines.push(['Metric', 'Value'].map(csvCell).join(','))
  lines.push(['Flags raised (confirmed)', m.total_flags ?? 0].map(csvCell).join(','))
  lines.push(['Converted to change order (incl. accepted)', m.converted_to_co ?? 0].map(csvCell).join(','))
  lines.push(['Dismissed as in scope', m.dismissed_flags ?? 0].map(csvCell).join(','))
  lines.push(['Awaiting borderline review', m.pending_review_flags ?? 0].map(csvCell).join(','))
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

  if (data.truncated) {
    lines.push(csvCell('This export is based on a large volume of data for the selected period and may be undercounting some figures. Narrow the date range for a fully accurate total.'))
  }

  lines.push('Financial overview summary')
  lines.push(['Metric', 'Value'].map(csvCell).join(','))
  lines.push(['Portfolio contract value (base + all accepted change orders; not period-filtered)', m.effective_value ?? 0].map(csvCell).join(','))
  lines.push(['Base contract value', m.base_value ?? 0].map(csvCell).join(','))
  lines.push(['Change-order value added in period', m.co_impact ?? 0].map(csvCell).join(','))
  lines.push(['Change orders sent in period', m.cos_raised ?? 0].map(csvCell).join(','))
  lines.push(['Change orders accepted', m.cos_accepted ?? 0].map(csvCell).join(','))
  lines.push(['Currency', data.currency].map(csvCell).join(','))
  lines.push('')

  lines.push(`Contract value by client (${(data.byClient || []).length})`)
  lines.push(['Client', 'Value'].map(csvCell).join(','))
  for (const c of (data.byClient || [])) {
    lines.push([c.client_name, c.value].map(csvCell).join(','))
  }
  lines.push('')

  lines.push(`Contract value by project type (${(data.byType || []).length})`)
  lines.push(['Type', 'Value'].map(csvCell).join(','))
  for (const t of (data.byType || [])) {
    lines.push([t.type_label, t.value].map(csvCell).join(','))
  }
  lines.push('')

  if (data.coGrid) {
    lines.push('Change order impact grid')
    lines.push(['Sent', 'Accepted', 'Declined', 'Pending', 'Closed / expired'].map(csvCell).join(','))
    lines.push([data.coGrid.raised, data.coGrid.accepted, data.coGrid.declined, data.coGrid.pending, data.coGrid.closed].map(csvCell).join(','))
  }

  return lines.join('\r\n')
}
