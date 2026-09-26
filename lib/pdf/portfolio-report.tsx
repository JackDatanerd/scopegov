// lib/pdf/portfolio-report.tsx
// Compliance/board-facing export of the Portfolio dashboard. Same
// @react-pdf/renderer approach as lib/pdf/audit-report.tsx (pure Node, no
// browser/Chromium) — see the FIX note in api/reports/portfolio/export/
// route.ts for why this exists.

import React from 'react'
import { Document, Page, View, Text, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { PortfolioData } from '@/lib/reports/portfolio-data'
import { formatDateTimeInZone, formatDateInZone } from '@/lib/utils/timezone'
import { PDF_FONT, sanitizeForPdf } from '@/lib/pdf/fonts'

export interface PortfolioReportData {
  agencyName: string
  workspaceName: string
  generatedBy: string
  generatedAt: string
  timeZone?: string
  periodLabel: string
  canViewFinancials: boolean
  data: PortfolioData
}

function fmtDateTime(iso: string, tz?: string) {
  return formatDateTimeInZone(iso, tz)
}
// A timestamp's calendar date in the WORKSPACE's zone — the header above already prints in that zone, and this
// used to format in the server's zone, so a flag raised just after midnight could show as the previous day.
function fmtDate(iso: string, tz?: string) {
  return formatDateInZone(iso, tz)
}
// Snapshot dates are plain calendar days (YYYY-MM-DD, no time): format them as-is. Running them through a zone
// conversion would shift them by a day in any zone behind UTC.
function fmtSnapshotDate(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
}
function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(amount)
  } catch { return `${currency} ${Math.round(amount).toLocaleString()}` }
}

const s = StyleSheet.create({
  page:       { fontFamily: PDF_FONT.sans, fontSize: 9, color: '#1A1A1A', padding: '36 40' },
  header:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2 solid #1A5C3A', paddingBottom: 12, marginBottom: 16 },
  h1:         { fontFamily: PDF_FONT.bold, fontSize: 15, color: '#1A5C3A', marginBottom: 3 },
  h2:         { fontFamily: PDF_FONT.bold, fontSize: 11, color: '#1A1A1A', marginTop: 18, marginBottom: 8 },
  meta:       { fontSize: 8, color: '#909090' },
  metaRight:  { fontSize: 8, color: '#909090', textAlign: 'right' },
  metricRow:  { flexDirection: 'row', gap: 10, marginBottom: 4 },
  metricBox:  { flex: 1, border: '1 solid #E5E1D8', borderRadius: 3, padding: 8 },
  metricLbl:  { fontSize: 7, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 3 },
  metricVal:  { fontSize: 14, fontFamily: PDF_FONT.bold, color: '#1A1A1A' },
  tableHdr:   { flexDirection: 'row', borderBottom: '1 solid #1A1A1A', paddingBottom: 5, marginBottom: 2 },
  th:         { fontSize: 7, fontFamily: PDF_FONT.bold, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.4 },
  row:        { flexDirection: 'row', borderBottom: '1 solid #F2F0EA', paddingVertical: 5 },
  td:         { fontSize: 8.5, color: '#1A1A1A' },
  tdSub:      { fontSize: 7.5, color: '#909090' },
  emptyNote:  { fontSize: 8.5, color: '#909090', paddingVertical: 8 },
  footer:     { position: 'absolute', bottom: 20, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8, borderTop: '1 solid #E5E1D8', fontSize: 7.5, color: '#B0B0B0' },
})

// Evenly thin a long series to at most `max` rows, always keeping first + last.
function sampleHistory<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.round((i * (rows.length - 1)) / (max - 1))])
  return out
}

const FLAG_COL = { project: 130, flag: 210, severity: 55 }
const STALL_COL = { kind: 32, project: 170, status: 90, since: 80 }
const RISK_COL = { project: 200, flags: 110, docs: 60 }
const EXC_COL = { date: 80, what: 270 }
const RISK_ROWS = 20
const EXC_ROWS = 15
// FIX (Portfolio independent pass): "Projects by risk" and "Exceptions"
// were both deliberately capped, specifically to keep this a short,
// readable summary (see the FIX notes at their own render sites below) —
// but "Documents needing action" (stuckDocs) had no equivalent cap.
// scope-health.ts returns every stalled/declined/expired/changes-requested/
// countered document workspace-wide with no limit parameter to cap it with,
// so a workspace with a lot of history could render an unbounded number of
// rows here, against the export route's own 60-second timeout.
const STALL_ROWS = 40
// FIX (Projects & Dashboard / Portfolio deep audit): "Open scope flags" was
// the one list on this page that STALL_ROWS/EXC_ROWS's own reasoning was
// never applied to, and it's the biggest of the three by default — the PDF
// path calls getPortfolioData with no flagsPerSeverity override, so
// data.openFlags can already be up to 300 rows (100 per severity × 3) before
// this render even sees it. It was mapped with no slice() at all, directly
// contradicting this file's own stated purpose ("a short, readable summary")
// and reintroducing the same unbounded-render / 60s-timeout risk this
// module's other two lists were deliberately capped to avoid.
const FLAG_ROWS = 40

function PortfolioReportDocument({ report }: { report: PortfolioReportData }) {
  const { data, canViewFinancials } = report
  const c = data.current

  const tz = report.timeZone
  const stuck = data.stuckDocs

  return (
    <Document>
      <Page size="A4" style={s.page} wrap>
        <View style={s.header} fixed>
          <View>
            <Text style={s.h1}>Portfolio Report</Text>
            <Text style={s.meta}>{report.workspaceName} · {report.agencyName}</Text>
            <Text style={s.meta}>Current position as of {fmtDateTime(c.asOf, report.timeZone)} · trend period: {report.periodLabel}</Text>
          </View>
          <View>
            <Text style={s.metaRight}>Generated by {report.generatedBy}</Text>
            <Text style={s.metaRight}>{fmtDateTime(report.generatedAt, report.timeZone)}</Text>
          </View>
        </View>

        {c ? (
          <View style={s.metricRow}>
            <View style={s.metricBox}>
              <Text style={s.metricLbl}>Open scope flags</Text>
              <Text style={s.metricVal}>{c.openFlagsCount}</Text>
            </View>
            <View style={s.metricBox}>
              <Text style={s.metricLbl}>Contract value at risk</Text>
              <Text style={s.metricVal}>
                {canViewFinancials && c.contractValueAtRisk !== null ? fmtMoney(c.contractValueAtRisk, data.currency) : '—'}
              </Text>
            </View>
            <View style={s.metricBox}>
              <Text style={s.metricLbl}>Exceptions granted</Text>
              <Text style={s.metricVal}>{c.exceptionsCount}</Text>
            </View>
            <View style={s.metricBox}>
              <Text style={s.metricLbl}>Stalled documents</Text>
              <Text style={s.metricVal}>{c.stalledSowCount + c.stalledCoCount}</Text>
            </View>
          </View>
        ) : null}
        {c.borderlineFlagsCount > 0 && (
          <Text style={s.tdSub}>
            {c.borderlineFlagsCount} Guardian flag{c.borderlineFlagsCount === 1 ? '' : 's'} awaiting human review {c.borderlineFlagsCount === 1 ? 'is' : 'are'} not counted above.
          </Text>
        )}

        {c.byCurrency.length > 1 && (
          <>
            <Text style={s.h2}>By currency</Text>
            <View style={s.tableHdr}>
              <Text style={[s.th, { width: 60 }]}>Currency</Text>
              <Text style={[s.th, { width: 90 }]}>Active projects</Text>
              <Text style={[s.th, { width: 80 }]}>Open flags</Text>
              <Text style={[s.th, { flex: 1 }]}>Value at risk</Text>
              {/* FIX (fix round, Portfolio section 8): exceptionsValueTotal is
                  computed per currency and the CSV export already carries it —
                  it was just never added to this table (or the matching one on
                  the dashboard), so a non-dominant currency's exceptions value
                  had no way to reach either the screen or the PDF. */}
              <Text style={[s.th, { flex: 1 }]}>Exceptions value</Text>
            </View>
            {c.byCurrency.map((row, i) => (
              <View key={i} style={s.row} wrap={false}>
                <Text style={[s.td, { width: 60 }]}>{row.currency}</Text>
                <Text style={[s.td, { width: 90 }]}>{row.activeProjectCount}</Text>
                <Text style={[s.td, { width: 80 }]}>{row.openFlagsCount}</Text>
                <Text style={[s.td, { flex: 1 }]}>
                  {canViewFinancials && row.contractValueAtRisk !== null ? fmtMoney(row.contractValueAtRisk, row.currency) : '—'}
                </Text>
                <Text style={[s.td, { flex: 1 }]}>
                  {canViewFinancials && row.exceptionsValueTotal !== null ? fmtMoney(row.exceptionsValueTotal, row.currency) : '—'}
                </Text>
              </View>
            ))}
          </>
        )}

        {data.projectRisk.length > 0 && (
          <>
            <Text style={s.h2}>
              Projects by risk ({data.projectRisk.length > RISK_ROWS ? `top ${RISK_ROWS} of ${data.projectRisk.length}` : data.projectRisk.length})
            </Text>
            <View style={s.tableHdr}>
              <Text style={[s.th, { width: RISK_COL.project }]}>Project</Text>
              <Text style={[s.th, { width: RISK_COL.flags }]}>Open flags</Text>
              <Text style={[s.th, { width: RISK_COL.docs }]}>Stuck docs</Text>
              <Text style={[s.th, { flex: 1 }]}>Value at risk</Text>
            </View>
            {data.projectRisk.slice(0, RISK_ROWS).map((r, i) => (
              <View key={i} style={s.row} wrap={false}>
                <View style={{ width: RISK_COL.project }}>
                  <Text style={s.td}>{r.projectName}</Text>
                  {r.clientName && <Text style={s.tdSub}>{r.clientName}</Text>}
                </View>
                <View style={{ width: RISK_COL.flags }}>
                  <Text style={s.td}>{r.openFlags}{r.highFlags > 0 ? ` (${r.highFlags} high)` : ''}</Text>
                  {r.borderlineFlags > 0 && <Text style={s.tdSub}>+{r.borderlineFlags} awaiting review</Text>}
                </View>
                <Text style={[s.td, { width: RISK_COL.docs }]}>{r.stuckDocs}</Text>
                <Text style={[s.td, { flex: 1 }]}>
                  {canViewFinancials && r.atRisk !== null ? fmtMoney(r.atRisk, r.currency) : '—'}
                </Text>
              </View>
            ))}
          </>
        )}

        <Text style={s.h2}>
          Open scope flags ({data.openFlagsTotal > Math.min(data.openFlags.length, FLAG_ROWS)
            ? `highest severity first: ${Math.min(data.openFlags.length, FLAG_ROWS)} of ${data.openFlagsTotal} — the CSV export lists every one`
            : data.openFlags.length})
        </Text>
        {data.openFlags.length === 0 ? (
          <Text style={s.emptyNote}>No open flags across the portfolio.</Text>
        ) : (
          <>
            <View style={s.tableHdr}>
              <Text style={[s.th, { width: FLAG_COL.project }]}>Project</Text>
              <Text style={[s.th, { width: FLAG_COL.flag }]}>Flag</Text>
              <Text style={[s.th, { width: FLAG_COL.severity }]}>Severity</Text>
              <Text style={[s.th, { flex: 1 }]}>Raised</Text>
            </View>
            {/* FIX (Projects & Dashboard / Portfolio deep audit): capped like every
                other long list in this report — see FLAG_ROWS above. data.openFlags
                already arrives highest-severity-then-newest first (portfolio-data.ts),
                so the cap keeps the flags that matter most, matching the header text
                and the CSV export's own ordering intent. */}
            {data.openFlags.slice(0, FLAG_ROWS).map((f, i) => (
              <View key={i} style={s.row} wrap={false}>
                <View style={{ width: FLAG_COL.project }}>
                  <Text style={s.td}>{f.projectName}</Text>
                  {f.clientName && <Text style={s.tdSub}>{f.clientName}</Text>}
                </View>
                <View style={{ width: FLAG_COL.flag }}>
                  <Text style={s.td}>{f.description}</Text>
                  <Text style={s.tdSub}>Ref: {f.sowReference}</Text>
                </View>
                <Text style={[s.td, { width: FLAG_COL.severity, textTransform: 'capitalize' }]}>{f.severity}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.td}>{fmtDate(f.createdAt, tz)}</Text>
                  {/* FIX (fix round, Portfolio section 8): truthy check hid a genuine
                      $0 contract value; the CSV export of this same data shows 0. */}
                  {canViewFinancials && f.contractValue != null ? (
                    <Text style={s.tdSub}>{fmtMoney(f.contractValue, f.currency)}</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </>
        )}

        <Text style={s.h2}>
          Documents needing action ({stuck.length > STALL_ROWS ? `oldest ${STALL_ROWS} of ${stuck.length} — the CSV export lists every one` : stuck.length})
        </Text>
        {stuck.length === 0 ? (
          <Text style={s.emptyNote}>No stalled, declined or expired documents across the portfolio.</Text>
        ) : (
          <>
            <View style={s.tableHdr}>
              <Text style={[s.th, { width: STALL_COL.kind }]}>Type</Text>
              <Text style={[s.th, { width: STALL_COL.project }]}>Document</Text>
              <Text style={[s.th, { width: STALL_COL.status }]}>Status</Text>
              <Text style={[s.th, { width: STALL_COL.since }]}>Since</Text>
              <Text style={[s.th, { flex: 1 }]}>Amount</Text>
            </View>
            {/* FIX (Portfolio independent pass): capped like every other long list in this report —
                see STALL_ROWS above. stuckDocs already arrives oldest-first (scope-health.ts), so the
                cap keeps the most overdue items, matching the CSV export's own ordering intent. */}
            {stuck.slice(0, STALL_ROWS).map((item, i) => (
              <View key={i} style={s.row} wrap={false}>
                <Text style={[s.td, { width: STALL_COL.kind }]}>{item.kind}</Text>
                <View style={{ width: STALL_COL.project }}>
                  <Text style={s.td}>{item.kind === 'CO' ? `${item.title} — ${item.projectName}` : item.projectName}</Text>
                  {item.clientName && <Text style={s.tdSub}>{item.clientName}</Text>}
                </View>
                <Text style={[s.td, { width: STALL_COL.status }]}>{item.reason}</Text>
                <Text style={[s.td, { width: STALL_COL.since }]}>{fmtDate(item.since, tz)}</Text>
                <Text style={[s.td, { flex: 1 }]}>
                  {/* A genuine $0 total must show as $0 (truthy check hid it before). */}
                  {canViewFinancials && item.total != null ? fmtMoney(item.total, item.currency || 'USD') : '—'}
                </Text>
              </View>
            ))}
          </>
        )}

        {c && (
          <>
            <Text style={s.h2}>Exceptions granted, all-time</Text>
            <Text style={s.td}>
              {c.exceptionsCount} scope item{c.exceptionsCount === 1 ? '' : 's'} waived across the portfolio
              {canViewFinancials && c.exceptionsValueTotal !== null
                ? ` — representing ${fmtMoney(c.exceptionsValueTotal, data.currency)} in scope given away outside a change order.`
                : '.'}
            </Text>
            {data.exceptions.length > 0 && (
              <>
                <View style={[s.tableHdr, { marginTop: 8 }]}>
                  <Text style={[s.th, { width: EXC_COL.date }]}>Granted</Text>
                  <Text style={[s.th, { width: EXC_COL.what }]}>Project / what was granted</Text>
                  <Text style={[s.th, { flex: 1 }]}>Value</Text>
                </View>
                {data.exceptions.slice(0, EXC_ROWS).map((e, i) => (
                  <View key={i} style={s.row} wrap={false}>
                    <Text style={[s.td, { width: EXC_COL.date }]}>{fmtDate(e.createdAt, tz)}</Text>
                    <View style={{ width: EXC_COL.what }}>
                      <Text style={s.td}>{e.projectName}</Text>
                      <Text style={s.tdSub}>{e.grantedWhat}</Text>
                    </View>
                    <Text style={[s.td, { flex: 1 }]}>
                      {canViewFinancials && e.estimatedValue !== null ? fmtMoney(e.estimatedValue, e.currency) : '—'}
                    </Text>
                  </View>
                ))}
                {data.exceptionsTotal > Math.min(data.exceptions.length, EXC_ROWS) && (
                  <Text style={s.tdSub}>Newest {Math.min(data.exceptions.length, EXC_ROWS)} of {data.exceptionsTotal} shown — the CSV export lists all of them.</Text>
                )}
              </>
            )}
          </>
        )}

        <Text style={s.h2}>History — {report.periodLabel}</Text>
        {data.history.length < 2 ? (
          <Text style={s.emptyNote}>Not enough daily snapshots yet to show a trend.</Text>
        ) : (
          <>
            <View style={s.tableHdr}>
              <Text style={[s.th, { width: 100 }]}>Date</Text>
              <Text style={[s.th, { width: 100 }]}>Open flags</Text>
              <Text style={[s.th, { flex: 1 }]}>Value at risk ({data.currency} only)</Text>
            </View>
            {/* FIX (fix round, Portfolio section 8): a row's own dominant
                currency that day (now carried per row) can differ from
                today's — such a row arrives with contractValueAtRisk already
                nulled at the source, indistinguishable here from a plain
                permission redaction. Name the actual currency that day
                instead of a bare dash, matching the CSV export's row. */}
            {sampleHistory(data.history, 30).map((h, i) => (
              <View key={i} style={s.row} wrap={false}>
                <Text style={[s.td, { width: 100 }]}>{fmtSnapshotDate(h.date)}</Text>
                <Text style={[s.td, { width: 100 }]}>{h.openFlagsCount}</Text>
                <Text style={[s.td, { flex: 1 }]}>
                  {!canViewFinancials
                    ? '—'
                    : h.contractValueAtRisk !== null
                    ? fmtMoney(h.contractValueAtRisk, data.currency)
                    : `n/a (${h.currency} that day)`}
                </Text>
              </View>
            ))}
          </>
        )}

        <View style={s.footer} fixed>
          <Text>ScopeGov portfolio report · scopegov.app</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderPortfolioReportPdf(report: PortfolioReportData): Promise<Buffer> {
  return renderToBuffer(<PortfolioReportDocument report={sanitizeForPdf(report)} />)
}
