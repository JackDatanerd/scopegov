export const runtime = 'nodejs'
export const maxDuration = 60

// app/api/reports/portfolio/export/route.ts
//   ?format=csv|pdf   (default csv)
//   &period=30d|90d|6m|12m   (default 90d — same options as the dashboard)
//
// FEATURE (deep audit, section 8): the Portfolio dashboard had no export
// at all — every other rollup surface in the product (the audit log via
// api/reports/audit-export) offers CSV and PDF, but a workspace-wide
// scope-governance summary, the exact thing an agency principal would
// want to hand to a client or forward to a partner who doesn't have a
// login, had no path out of the browser. Same permission gate as the
// dashboard itself (VIEW_PORTFOLIO) — exporting is a stricter form of
// the same read, not a separate capability, matching the audit-export
// route's own reasoning for not inventing a new permission.

import { getWorkspaceTimeZone } from '@/lib/utils/workspace-time'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { parsePeriod } from '@/lib/reports/period'
import { csvCell, CSV_BOM } from '@/lib/utils/csv'
import { getPortfolioData, PERIOD_LABELS } from '@/lib/reports/portfolio-data'
import { renderPortfolioReportPdf } from '@/lib/pdf/portfolio-report'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_PORTFOLIO'))
      return NextResponse.json({ error: 'Missing permission: VIEW_PORTFOLIO' }, { status: 403 })

    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
    const canViewClients = hasPermission(session, 'VIEW_CLIENT_DATA')
    const { searchParams } = new URL(request.url)
    const format = (searchParams.get('format') || 'csv') as 'csv' | 'pdf'
    const period = parsePeriod(searchParams.get('period'))
    if (!['csv', 'pdf'].includes(format))
      return NextResponse.json({ error: 'Unsupported format' }, { status: 400 })
    if (!period)
      return NextResponse.json({ error: 'Invalid period' }, { status: 400 })

    const service = createServiceClient()
    const data = await getPortfolioData(service, session.workspaceId, period, canViewFinancials, canViewClients)
    const filenameBase = filenameSlug(session.workspaceName, period)

    // Build the file FIRST, audit after: the audit row used to be written
    // before generation, so a failed render still recorded a successful export.
    let response: NextResponse
    if (format === 'csv') {
      const csv = toCsv(data, canViewFinancials, PERIOD_LABELS[period])
      response = new NextResponse(new Uint8Array(Buffer.from(CSV_BOM + csv, 'utf-8')), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filenameBase}.csv"`,
        },
      })
    } else {
      const buffer = await renderPortfolioReportPdf({
        agencyName: session.agencyName,
        workspaceName: session.workspaceName,
        generatedBy: session.name,
        generatedAt: new Date().toISOString(),
        timeZone: await getWorkspaceTimeZone(service, session.workspaceId),
        periodLabel: PERIOD_LABELS[period],
        canViewFinancials,
        data,
      })
      response = new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filenameBase}.pdf"`,
        },
      })
    }

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'portfolio.exported',
      entityType: 'workspace', entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { format, period },
    })
    return response
  } catch (err) {
    console.error('Portfolio export error:', err)
    return NextResponse.json({ error: 'Could not generate export' }, { status: 500 })
  }
}

function filenameSlug(workspaceName: string, period: string): string {
  const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace'
  const date = new Date().toISOString().slice(0, 10)
  return `${slug}-portfolio-${period}-${date}`
}

function toCsv(data: Awaited<ReturnType<typeof getPortfolioData>>, canViewFinancials: boolean, periodLabel: string): string {
  const lines: string[] = []
  const c = data.current
  const money = (v: number | null) => (canViewFinancials ? (v ?? 0) : 'redacted')

  // Every headline figure below is LIVE ("as of" the timestamp); only the
  // History section is scoped to the selected period.
  lines.push('Portfolio summary')
  lines.push(['Metric', 'Value'].map(csvCell).join(','))
  lines.push(['As of', c.asOf].map(csvCell).join(','))
  lines.push(['Money figures currency', data.currency].map(csvCell).join(','))
  lines.push(['Active projects (all currencies)', c.activeProjectCount].map(csvCell).join(','))
  lines.push(['Open scope flags (all currencies)', c.openFlagsCount].map(csvCell).join(','))
  lines.push(['Guardian flags awaiting review', c.borderlineFlagsCount].map(csvCell).join(','))
  lines.push([`Contract value at risk (${data.currency})`, money(c.contractValueAtRisk)].map(csvCell).join(','))
  lines.push(['Exceptions granted, all-time', c.exceptionsCount].map(csvCell).join(','))
  lines.push([`Exceptions value, all-time (${data.currency})`, money(c.exceptionsValueTotal)].map(csvCell).join(','))
  lines.push(['Stalled SOWs', c.stalledSowCount].map(csvCell).join(','))
  lines.push(['Stalled change orders', c.stalledCoCount].map(csvCell).join(','))
  lines.push('')

  if (c.byCurrency.length > 1) {
    lines.push('By currency')
    lines.push(['Currency', 'Active projects', 'Open flags', 'Contract value at risk', 'Exceptions value, all-time'].map(csvCell).join(','))
    for (const row of c.byCurrency) {
      lines.push([row.currency, row.activeProjectCount, row.openFlagsCount, money(row.contractValueAtRisk), money(row.exceptionsValueTotal)].map(csvCell).join(','))
    }
    lines.push('')
  }

  lines.push(data.openFlagsTotal > data.openFlags.length
    ? `Open scope flags (highest severity first: ${data.openFlags.length} of ${data.openFlagsTotal})`
    : `Open scope flags (${data.openFlags.length})`)
  lines.push(['Project', 'Client', 'Severity', 'Flag', 'SOW reference', 'Raised', 'Contract value', 'Currency'].map(csvCell).join(','))
  for (const f of data.openFlags) {
    lines.push([
      f.projectName, f.clientName || '', f.severity, f.description, f.sowReference,
      new Date(f.createdAt).toISOString(),
      canViewFinancials ? (f.contractValue ?? '') : 'redacted',
      f.currency,
    ].map(csvCell).join(','))
  }
  lines.push('')

  const stalledItems = [
    ...data.stalledSows.map(sw => ({ kind: 'SOW', project: sw.projectName, client: sw.clientName || '', since: sw.since, amount: '' as number | string, currency: '' })),
    ...data.stalledCos.map(co => ({
      kind: 'CO', project: `${co.title} — ${co.projectName}`, client: '', since: co.since,
      amount: canViewFinancials ? (co.total ?? '') : 'redacted', currency: co.currency,
    })),
  ]
  lines.push(`Stalled documents (${stalledItems.length})`)
  lines.push(['Type', 'Document', 'Client', 'Stalled since', 'Amount', 'Currency'].map(csvCell).join(','))
  for (const item of stalledItems) {
    lines.push([item.kind, item.project, item.client, new Date(item.since).toISOString(), item.amount, item.currency].map(csvCell).join(','))
  }
  lines.push('')

  // The period selector only ever scoped THIS section; the export used to omit
  // it entirely, so 30-day and 12-month files were identical.
  lines.push(`History (${periodLabel})`)
  lines.push(['Date', 'Open flags', `Contract value at risk (${data.currency})`, 'Exceptions granted, all-time'].map(csvCell).join(','))
  for (const h of data.history) {
    lines.push([h.date, h.openFlagsCount, canViewFinancials ? (h.contractValueAtRisk ?? 0) : 'redacted', h.exceptionsCount].map(csvCell).join(','))
  }

  return lines.join('\r\n')
}
