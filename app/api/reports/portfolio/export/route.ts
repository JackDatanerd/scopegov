export const runtime = 'nodejs'

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
// dashboard itself (VIEW_ALL_PROJECTS) — exporting is a stricter form of
// the same read, not a separate capability, matching the audit-export
// route's own reasoning for not inventing a new permission.

import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { getPortfolioData, PERIOD_LABELS } from '@/lib/reports/portfolio-data'
import { renderPortfolioReportPdf } from '@/lib/pdf/portfolio-report'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_ALL_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_ALL_PROJECTS' }, { status: 403 })

    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
    const { searchParams } = new URL(request.url)
    const format = (searchParams.get('format') || 'csv') as 'csv' | 'pdf'
    const period = searchParams.get('period') || '90d'
    if (!['csv', 'pdf'].includes(format))
      return NextResponse.json({ error: 'Unsupported format' }, { status: 400 })

    const service = createServiceClient()
    const data = await getPortfolioData(service, session.workspaceId, period, canViewFinancials)

    // Same reasoning as audit_log.exported: who pulled a portfolio-wide
    // scope-risk summary, and when, is itself something a compliance
    // trail should capture.
    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'portfolio.exported',
      entityType: 'workspace', entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { format, period },
    })

    const filenameBase = filenameSlug(session.workspaceName, period)

    if (format === 'csv') {
      const csv = toCsv(data, canViewFinancials)
      // BUG-008 convention: Uint8Array for NextResponse BodyInit
      return new NextResponse(new Uint8Array(Buffer.from(csv, 'utf-8')), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filenameBase}.csv"`,
        },
      })
    }

    const buffer = await renderPortfolioReportPdf({
      agencyName: session.agencyName,
      workspaceName: session.workspaceName,
      generatedBy: session.name,
      generatedAt: new Date().toISOString(),
      periodLabel: PERIOD_LABELS[period] || PERIOD_LABELS['90d'],
      canViewFinancials,
      data,
    })
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filenameBase}.pdf"`,
      },
    })
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

// Same CSV-formula-injection guard as api/reports/audit-export/route.ts —
// entity/project/client names in this export are user-supplied strings
// (project names, CO titles, client names), so the same neutralization
// applies here.
function csvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@]/.test(str)) str = `'${str}`
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function toCsv(data: Awaited<ReturnType<typeof getPortfolioData>>, canViewFinancials: boolean): string {
  const lines: string[] = []
  const c = data.current

  lines.push('Portfolio summary')
  lines.push(['Metric', 'Value'].map(csvCell).join(','))
  lines.push(['Open scope flags', c?.openFlagsCount ?? 0].map(csvCell).join(','))
  lines.push(['Contract value at risk', canViewFinancials ? (c?.contractValueAtRisk ?? 0) : 'redacted'].map(csvCell).join(','))
  lines.push(['Exceptions granted', c?.exceptionsCount ?? 0].map(csvCell).join(','))
  lines.push(['Exceptions value, all-time', canViewFinancials ? (c?.exceptionsValueTotal ?? 0) : 'redacted'].map(csvCell).join(','))
  lines.push(['Stalled SOWs', c?.stalledSowCount ?? 0].map(csvCell).join(','))
  lines.push(['Stalled change orders', c?.stalledCoCount ?? 0].map(csvCell).join(','))
  lines.push(['Active projects', c?.activeProjectCount ?? 0].map(csvCell).join(','))
  lines.push(['Currency', data.currency].map(csvCell).join(','))
  lines.push('')

  lines.push(`Open scope flags (${data.openFlags.length})`)
  lines.push(['Project', 'Client', 'Severity', 'Flag', 'SOW reference', 'Raised', 'Contract value'].map(csvCell).join(','))
  for (const f of data.openFlags) {
    lines.push([
      f.projectName, f.clientName || '', f.severity, f.description, f.sowReference,
      new Date(f.createdAt).toISOString(),
      canViewFinancials && f.contractValue ? f.contractValue : (canViewFinancials ? '' : 'redacted'),
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

  return lines.join('\r\n')
}
