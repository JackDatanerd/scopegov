export const runtime = 'nodejs'
export const maxDuration = 60

// app/api/reports/portfolio/export/route.ts
//   ?format=csv|pdf   (default csv)
//   &period=30d|90d|6m|12m|all   (default 90d — same options as the dashboard)
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
    // The CSV is the complete record (every open flag and exception); the PDF is a readable summary, so it
    // keeps the dashboard's per-severity cap and says so.
    const data = await getPortfolioData(service, session.workspaceId, period, canViewFinancials, canViewClients,
      format === 'csv' ? { flagsPerSeverity: 5000, exceptionsLimit: 5000 } : {})
    const filenameBase = filenameSlug(session.workspaceSlug, session.workspaceName, period)

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

function filenameSlug(workspaceSlug: string, workspaceName: string, period: string): string {
  // FIX (deep audit, Settings independent re-pass — feature gap): see
  // reports/export/route.ts's sibling function for the full story — this
  // was the second of three copies of the same re-derive-it-every-time
  // logic. Use the canonical workspaces.slug now; fall back only for a
  // defensively-empty value.
  const slug = (workspaceSlug || '').trim()
    || workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    || 'workspace'
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

  // Projects by risk — the answer to "where is the 'contract value at risk' coming from?".
  lines.push(`Projects by risk (${data.projectRisk.length})`)
  lines.push(['Project', 'Client', 'Status', 'Contract value', 'Open flags', 'High-severity flags', 'Flags awaiting review',
    'Flag exposure', 'Exceptions', 'Exception exposure', 'Contract value at risk', 'Stuck documents', 'Currency'].map(csvCell).join(','))
  for (const r of data.projectRisk) {
    lines.push([
      r.projectName, r.clientName || '', r.status, money(r.effectiveValue), r.openFlags, r.highFlags, r.borderlineFlags,
      money(r.flagRisk), r.exceptionsCount, money(r.exceptionsRisk), money(r.atRisk), r.stuckDocs, r.currency,
    ].map(csvCell).join(','))
  }
  lines.push('')

  // Every document needing the agency's action, not just the stalled ones: declined / expired / changes-
  // requested SOWs and declined / expired / countered COs are exactly what the Dashboard's Needs attention
  // lists, and used to be missing here.
  lines.push(`Documents needing action (${data.stuckDocs.length})`)
  lines.push(['Type', 'Status', 'Document', 'Project', 'Client', 'Since', 'Amount', 'Currency'].map(csvCell).join(','))
  for (const d of data.stuckDocs) {
    lines.push([
      d.kind, d.reason, d.title, d.projectName, d.clientName || '', new Date(d.since).toISOString(),
      d.total === null && d.kind === 'CO' ? (canViewFinancials ? '' : 'redacted') : (d.total ?? ''), d.currency,
    ].map(csvCell).join(','))
  }
  lines.push('')

  lines.push(data.exceptionsTotal > data.exceptions.length
    ? `Exceptions granted (newest ${data.exceptions.length} of ${data.exceptionsTotal})`
    : `Exceptions granted (${data.exceptions.length})`)
  lines.push(['Granted', 'Project', 'Client', 'Deliverable', 'What was granted', 'Reason', 'Estimated value', 'Currency'].map(csvCell).join(','))
  for (const e of data.exceptions) {
    lines.push([
      new Date(e.createdAt).toISOString(), e.projectName, e.clientName || '', e.deliverable, e.grantedWhat, e.reason,
      money(e.estimatedValue), e.currency,
    ].map(csvCell).join(','))
  }
  lines.push('')

  // The period selector only ever scoped THIS section; the export used to omit
  // it entirely, so 30-day and 12-month files were identical.
  //
  // FIX (fix round, Portfolio section 8): a history row's own dominant
  // currency (now carried per row — see getPortfolioData) can differ from
  // today's if the workspace's mix has shifted since that day ran. Such a
  // row's contract_value_at_risk arrives already nulled at the source, and
  // this line used to coerce that null to 0 exactly like the on-screen
  // chart did — silently exporting "zero risk" for a day that was actually
  // just a different currency. A "Currency" column now makes every row
  // self-describing, and a mismatched row is spelled out rather than
  // zeroed.
  lines.push(`History (${periodLabel})`)
  lines.push(['Date', 'Open flags', `Contract value at risk (${data.currency} only)`, 'Currency that day', 'Exceptions granted, all-time'].map(csvCell).join(','))
  for (const h of data.history) {
    const riskCell = !canViewFinancials
      ? 'redacted'
      : h.contractValueAtRisk !== null ? h.contractValueAtRisk
      : `n/a — ${h.currency} was dominant that day`
    lines.push([h.date, h.openFlagsCount, riskCell, h.currency, h.exceptionsCount].map(csvCell).join(','))
  }

  return lines.join('\r\n')
}
