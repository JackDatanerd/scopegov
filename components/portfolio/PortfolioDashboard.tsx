'use client'
import { useState, useEffect, useMemo } from 'react'
import type React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatCurrency, formatDate, formatRelative } from '@/lib/utils/format'

type Period = '30d' | '90d' | '6m' | '12m' | 'all'

interface HistoryPoint {
  date: string
  openFlagsCount: number
  contractValueAtRisk: number | null
  exceptionsCount: number
  currency: string
}
interface OpenFlag {
  id: string; severity: 'high' | 'medium' | 'low'; description: string; sowReference: string
  createdAt: string; projectId: string; projectName: string; clientName: string | null
  contractValue: number | null; currency: string
}
interface StuckDoc {
  kind: 'SOW' | 'CO'; reason: string; stalled: boolean; title: string; total: number | null; currency: string
  projectId: string; projectName: string; clientName: string | null; since: string
}
interface RiskRow {
  projectId: string; projectName: string; clientName: string | null; status: string; currency: string
  effectiveValue: number | null
  openFlags: number; highFlags: number; borderlineFlags: number
  flagRisk: number | null; exceptionsCount: number; exceptionsRisk: number | null; atRisk: number | null
  stuckDocs: number
}
interface ExceptionItem {
  id: string; projectId: string; projectName: string; clientName: string | null
  deliverable: string; grantedWhat: string; reason: string
  estimatedValue: number | null; currency: string; createdAt: string
}

interface CurrencyRow {
  currency: string; activeProjectCount: number; openFlagsCount: number
  contractValueAtRisk: number | null; exceptionsValueTotal: number | null
}

interface PortfolioData {
  currency: string
  // Portfolio deep audit: `current` is now computed LIVE server-side (it used
  // to be the last daily snapshot, which disagreed with the lists below it and
  // was empty for a new workspace's first day).
  current: {
    openFlagsCount: number
    openFlagsBySeverity: { high: number; medium: number; low: number }
    borderlineFlagsCount: number
    exceptionsCount: number
    exceptionsValueTotal: number | null
    contractValueAtRisk: number | null
    stalledSowCount: number
    stalledCoCount: number
    activeProjectCount: number
    asOf: string
    byCurrency: CurrencyRow[]
  }
  history: HistoryPoint[]
  // FIX (deep audit, section 8): atRiskDelta is now null when the viewer
  // lacks VIEW_FINANCIALS — see api/reports/portfolio/route.ts.
  trend: { openFlagsDelta: number; atRiskDelta: number | null } | null
  openFlagsTotal?: number
  openFlags: OpenFlag[]
  stuckDocs: StuckDoc[]
  projectRisk: RiskRow[]
  exceptions: ExceptionItem[]
  exceptionsTotal: number
  riskModel: { openFlagRate: number; severityMultipliers: { high: number; medium: number; low: number } }
  hasSnapshots: boolean
}

// The flags table shows at most this many rows (the API returns up to this many PER severity).
const FLAG_LIST_LIMIT = 100

const PERIODS: { key: Period; label: string }[] = [
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: '6m', label: '6 months' },
  { key: '12m', label: '12 months' },
  { key: 'all', label: 'All time' },
]

const SEVERITY_META: Record<string, { label: string; colour: string }> = {
  high: { label: 'High', colour: 'var(--red)' },
  medium: { label: 'Medium', colour: 'var(--amber)' },
  low: { label: 'Low', colour: 'var(--text-4)' },
}

export default function PortfolioDashboard({ canViewFinancials, agencyName, canOpenProjects = false }: { canViewFinancials: boolean; agencyName: string; canOpenProjects?: boolean }) {
  const router = useRouter()
  const [period, setPeriod] = useState<Period>('90d')
  const [data, setData] = useState<PortfolioData | null>(null)
  const [loading, setLoading] = useState(true)
  // Portfolio deep audit: a failed request used to fall through to the
  // "No portfolio history yet — come back tomorrow" empty state (the fetch
  // never checked r.ok, so a 403/500 body became `data`). Errors now say so.
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [flagFilter, setFlagFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all')
  // FEATURE (deep audit, section 8): the dashboard had no export at all —
  // see api/reports/portfolio/export/route.ts. Same download-via-blob
  // pattern already used by AuditLogClient's CSV/PDF export.
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null)
  const [exportError, setExportError] = useState('')

  useEffect(() => {
    // FIX (deep audit, section 8): no cancellation guard — switching
    // periods twice quickly let a slower earlier response land after a
    // faster later one and silently overwrite it, showing stale-period
    // data with no indication anything was wrong. Same pattern already
    // used for this exact class of bug elsewhere (see the `cancelled`
    // flag on the workspace-defaults fetch in app/(app)/projects/new/
    // page.tsx).
    let cancelled = false
    setLoading(true)
    setLoadError('')
    fetch(`/api/reports/portfolio?period=${period}`)
      .then(async r => {
        const json = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(json.error || `Request failed (${r.status})`)
        return json
      })
      .then(json => { if (!cancelled) { setData(json); setLoading(false) } })
      .catch((e: unknown) => {
        if (!cancelled) {
          setData(null)
          setLoadError(e instanceof Error ? e.message : 'Could not load the portfolio')
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [period, reloadKey])

  // The API returns up to 100 flags of EACH severity, so filtering to "low" is never starved by newer
  // higher-severity flags. `flagsTotal` is the exact count for the chosen filter, so the header can say
  // "showing 100 of 240" instead of implying the list is everything.
  const filteredFlags = useMemo(() => {
    if (!data) return []
    const list = flagFilter === 'all' ? data.openFlags : data.openFlags.filter(f => f.severity === flagFilter)
    return list.slice(0, FLAG_LIST_LIMIT)
  }, [data, flagFilter])
  const flagsTotal = !data ? 0
    : flagFilter === 'all' ? (data.openFlagsTotal ?? data.openFlags.length)
    : data.current.openFlagsBySeverity[flagFilter]

  async function handleExport(format: 'csv' | 'pdf') {
    setExporting(format); setExportError('')
    try {
      const res = await fetch(`/api/reports/portfolio/export?format=${format}&period=${period}`)
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Export failed') }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') || ''
      const match = disposition.match(/filename="([^"]+)"/)
      const filename = match?.[1] || `portfolio.${format}`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : 'Export failed')
    } finally { setExporting(null) }
  }

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">
            Scope-governance rollup across every project · {agencyName}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="finp" style={{ width: 'auto' }} value={period}
            onChange={e => setPeriod(e.target.value as Period)}>
            {PERIODS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <button className="btn btn-ghost btn-sm" disabled={exporting !== null || loading || !data}
            onClick={() => handleExport('csv')} title="Export CSV">
            {exporting === 'csv' ? <span className="spin" /> : <><i className="ti ti-file-spreadsheet" style={{ marginRight: 6 }} />CSV</>}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={exporting !== null || loading || !data}
            onClick={() => handleExport('pdf')} title="Export PDF">
            {exporting === 'pdf' ? <span className="spin" /> : <><i className="ti ti-file-type-pdf" style={{ marginRight: 6 }} />PDF</>}
          </button>
        </div>
      </div>

      {exportError && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: -8, marginBottom: 12 }}>{exportError}</p>}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <span className="spin spin-dark" style={{ width: 24, height: 24 }} />
        </div>
      ) : loadError || !data ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-alert-triangle empty-state-icon" />
            <p className="empty-state-title">Couldn&apos;t load the portfolio</p>
            <p className="empty-state-sub">{loadError || 'Something went wrong.'}</p>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => setReloadKey(k => k + 1)}>Try again</button>
          </div>
        </div>
      ) : (
        <>
          <MetricStrip data={data} canViewFinancials={canViewFinancials} />
          <p style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '-14px 0 20px' }}>
            Live as of {formatRelative(data.current.asOf)}. The chart and “vs period start” figures use daily snapshots.
            {data.current.borderlineFlagsCount > 0 && ` ${data.current.borderlineFlagsCount} Guardian flag${data.current.borderlineFlagsCount === 1 ? '' : 's'} awaiting human review ${data.current.borderlineFlagsCount === 1 ? 'is' : 'are'} not counted as open.`}
          </p>
          {canViewFinancials && <RiskExplainer model={data.riskModel} />}
          {data.current.byCurrency.length > 1 && (
            <div className="surface surface-p" style={{ marginBottom: 24 }}>
              <div className="sec-hd" style={{ marginBottom: 10 }}>
                <div className="sec-title">By currency</div>
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 10 }}>
                Money can&apos;t be summed across currencies, so the headline value is {data.currency}. Counts above include every currency.
              </p>
              <table className="gov-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Currency</th><th>Active projects</th><th>Open flags</th>
                    {canViewFinancials && <th style={{ textAlign: 'right' }}>Value at risk</th>}
                    {/* FIX (fix round, Portfolio section 8): exceptionsValueTotal is
                        computed per currency (lib/reports/scope-health.ts) and the
                        CSV export already has this column — it was just never added
                        here, so a non-dominant currency's exceptions value had no
                        way to reach the screen at all, despite the paragraph above
                        pointing here for exactly that detail. */}
                    {canViewFinancials && <th style={{ textAlign: 'right' }}>Exceptions value</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.current.byCurrency.map(row => (
                    <tr key={row.currency}>
                      <td className="td-primary">{row.currency}</td>
                      <td>{row.activeProjectCount}</td>
                      <td>{row.openFlagsCount}</td>
                      {canViewFinancials && <td className="td-mono" style={{ textAlign: 'right' }}>{row.contractValueAtRisk !== null ? formatCurrency(row.contractValueAtRisk, row.currency) : '—'}</td>}
                      {canViewFinancials && <td className="td-mono" style={{ textAlign: 'right' }}>{row.exceptionsValueTotal !== null ? formatCurrency(row.exceptionsValueTotal, row.currency) : '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, alignItems: 'start', marginBottom: 24 }}>
            <div className="surface surface-p">
              <div className="sec-hd" style={{ marginBottom: 16 }}>
                <div className="sec-title">
                  {canViewFinancials ? 'Contract value at risk' : 'Open scope flags'} over time
                </div>
              </div>
              <TrendChart
                points={data.history}
                mode={canViewFinancials ? 'risk' : 'flags'}
                currency={data.currency}
              />
              {/* FIX (fix round, Portfolio section 8): a history point's own
                  currency (see getPortfolioData) can differ from today's
                  dominant one if the workspace's mix has shifted since —
                  those points are nulled out at the source rather than
                  silently plotted under today's currency label. When
                  canViewFinancials is on, null here can only mean that (the
                  API never returns null for that field for any other
                  reason), so say so instead of leaving an unexplained dip. */}
              {canViewFinancials && data.history.some(h => h.contractValueAtRisk === null) && (
                <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
                  Some days aren&apos;t shown — the workspace&apos;s dominant currency was different on
                  those days, and money can&apos;t be mixed across currencies on one line.
                </p>
              )}
            </div>

            <div className="surface surface-p">
              <div className="sec-hd" style={{ marginBottom: 16 }}>
                <div className="sec-title">Open flags by severity</div>
              </div>
              <SeverityBreakdown breakdown={data.current.openFlagsBySeverity} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start', marginBottom: 24 }}>
            <StalledPanel docs={data.stuckDocs} canViewFinancials={canViewFinancials} canOpenProjects={canOpenProjects} />
            <ExceptionsPanel
              count={data.current.exceptionsCount}
              value={data.current.exceptionsValueTotal}
              items={data.exceptions}
              total={data.exceptionsTotal}
              canViewFinancials={canViewFinancials}
              canOpenProjects={canOpenProjects}
              currency={data.currency}
            />
          </div>

          <ProjectsByRisk rows={data.projectRisk} canViewFinancials={canViewFinancials} canOpenProjects={canOpenProjects} />

          <div>
            <div className="sec-hd">
              <div className="sec-title">Open scope flags ({filteredFlags.length}{flagsTotal > filteredFlags.length ? ` of ${flagsTotal} · highest severity first` : ''})</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['all', 'high', 'medium', 'low'] as const).map(s => (
                  <button key={s}
                    className={`btn btn-xs ${flagFilter === s ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setFlagFilter(s)}>
                    {s === 'all' ? 'All' : SEVERITY_META[s].label}
                  </button>
                ))}
              </div>
            </div>
            {filteredFlags.length === 0 ? (
              <div className="surface">
                <div className="empty-state" style={{ padding: '32px 24px' }}>
                  <i className="ti ti-shield-check empty-state-icon" />
                  <p className="empty-state-title">No open flags{flagFilter !== 'all' ? ` at ${flagFilter} severity` : ''}</p>
                  <p className="empty-state-sub">
                    {flagsTotal > 0
                      ? `${flagsTotal} exist but could not be listed — reload to try again.`
                      : 'Scope is under control across the portfolio right now.'}
                  </p>
                </div>
              </div>
            ) : (
              <div className="surface" style={{ overflow: 'hidden' }}>
                <table className="gov-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Flag</th>
                      <th>Severity</th>
                      {canViewFinancials && <th style={{ textAlign: 'right' }}>Contract value</th>}
                      <th>Raised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFlags.map(f => (
                      <tr key={f.id}
                        style={canOpenProjects ? { cursor: 'pointer' } : undefined}
                        onClick={canOpenProjects ? () => router.push(`/projects/${f.projectId}?tab=guardian`) : undefined}>
                        <td>
                          <div className="td-primary">
                            {canOpenProjects
                              ? <Link href={`/projects/${f.projectId}?tab=guardian`} onClick={e => e.stopPropagation()} style={{ color: 'inherit', textDecoration: 'none' }}>{f.projectName}</Link>
                              : f.projectName}
                          </div>
                          {f.clientName && <div className="td-sub">{f.clientName}</div>}
                        </td>
                        <td style={{ maxWidth: 340 }}>
                          <div style={{ fontSize: 13, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.description}
                          </div>
                          <div className="td-sub">Ref: {f.sowReference}</div>
                        </td>
                        <td>
                          <span className={`pill pill-${f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'amber' : 'slate'}`}>
                            {(SEVERITY_META[f.severity]?.label ?? f.severity)}
                          </span>
                        </td>
                        {canViewFinancials && (
                          <td className="td-mono" style={{ textAlign: 'right' }}>
                            {/* FIX (fix round, Portfolio section 8): a truthy check hid a
                                genuine $0 contract value (a pro-bono project, e.g.) as '—',
                                while the CSV export showed it as 0 for the same data — an
                                explicit null check keeps this in sync with the export. */}
                            {f.contractValue != null ? formatCurrency(f.contractValue, f.currency) : '—'}
                          </td>
                        )}
                        <td style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{formatRelative(f.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── METRIC STRIP ─────────────────────────────────────────────────
function MetricStrip({ data, canViewFinancials }: { data: PortfolioData; canViewFinancials: boolean }) {
  const c = data.current
  const trend = data.trend
  return (
    <div className="mstrip" style={{ marginBottom: 24 }}>
      <div className="mc">
        <div className="mc-lbl">Open scope flags</div>
        <div className={`mc-val${c.openFlagsCount > 0 ? ' red' : ''}`}>{c.openFlagsCount}</div>
        <div className="mc-sub">
          {trend && trend.openFlagsDelta !== 0
            ? `${trend.openFlagsDelta > 0 ? '+' : ''}${trend.openFlagsDelta} vs period start`
            : `Across ${c.activeProjectCount} active projects`}
        </div>
      </div>
      <div className="mc">
        <div className="mc-lbl">Contract value at risk</div>
        <div className="mc-val red">
          {canViewFinancials && c.contractValueAtRisk !== null ? formatCurrency(c.contractValueAtRisk, data.currency, true) : '—'}
        </div>
        <div className="mc-sub">
          {canViewFinancials && trend && trend.atRiskDelta !== null
            ? `${trend.atRiskDelta >= 0 ? '+' : ''}${formatCurrency(trend.atRiskDelta, data.currency, true)} vs period start`
            : 'Severity-weighted estimate'}
        </div>
      </div>
      <div className="mc">
        <div className="mc-lbl">Exceptions granted</div>
        <div className="mc-val">{c.exceptionsCount}</div>
        <div className="mc-sub">
          {canViewFinancials && c.exceptionsValueTotal !== null
            ? `${formatCurrency(c.exceptionsValueTotal, data.currency, true)} total value`
            : 'All-time, this workspace'}
        </div>
      </div>
      <div className="mc">
        <div className="mc-lbl">Stalled documents</div>
        <div className={`mc-val${(c.stalledSowCount + c.stalledCoCount) > 0 ? ' red' : ''}`}>
          {c.stalledSowCount + c.stalledCoCount}
        </div>
        <div className="mc-sub">
          {c.stalledSowCount} SOW · {c.stalledCoCount} CO
          {(() => { const other = data.stuckDocs.filter(d => !d.stalled).length; return other > 0 ? ` · +${other} declined/expired` : '' })()}
        </div>
      </div>
    </div>
  )
}

// ── TREND CHART (hand-rolled SVG — no charting dependency) ──────────
// FEATURE GAP closed (fix round, Portfolio section 8): lib/pdf/portfolio-
// report.tsx thins a long history down to 30 points before rendering it as
// a table (sampleHistory()), specifically so a long period doesn't produce
// an unreadable/oversized page — but this component, plotting the exact
// same `data.history` array, had no equivalent: one SVG path vertex and one
// hover-rect per row, uncapped. Combined with the missing row cap fixed in
// getPortfolioData, a mature workspace on "All time" was the worst case
// twice over; even now that the data itself is bounded, a multi-year daily
// series is still needlessly heavy to render as a line chart with no
// decimation. Evenly-spaced sampling (endpoints always kept) mirrors the
// PDF's own algorithm — daily precision is kept in full up to a year of
// history, and only compressed beyond that.
const MAX_CHART_POINTS = 366
function sampleForChart<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.round((i * (rows.length - 1)) / (max - 1))])
  return out
}

function TrendChart({ points: allPoints, mode, currency }: { points: HistoryPoint[]; mode: 'risk' | 'flags'; currency: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 640, H = 180, PAD = 8, PADL = 46 // left gutter for the y-axis labels

  // FIX (fix round, Portfolio section 8): in risk mode, a point whose own
  // currency didn't match today's dominant one arrives with
  // contractValueAtRisk already nulled (see getPortfolioData) — drop it from
  // the line entirely rather than coercing it to 0, which would draw a day
  // with a currency mismatch as a day with zero risk. Flag-count mode has no
  // currency concept, so every point is always kept.
  const points = sampleForChart(
    mode === 'risk' ? allPoints.filter(p => p.contractValueAtRisk !== null) : allPoints,
    MAX_CHART_POINTS,
  )

  const values = points.map(p => mode === 'risk' ? (p.contractValueAtRisk ?? 0) : p.openFlagsCount)
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1

  if (points.length < 2) {
    return <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '40px 0', textAlign: 'center' }}>
      Not enough history yet — check back after a few daily rollups.
    </div>
  }

  const xFor = (i: number) => PADL + (i / (points.length - 1)) * (W - PADL - PAD)
  const yFor = (v: number) => H - PAD - ((v - min) / range) * (H - PAD * 2)

  // Three gridlines (top / middle / bottom) with their values — the chart had no axis at all, so a reader
  // could only learn the scale by hovering.
  const ticks = [max, min + range / 2, min]
  const fmtTick = (v: number) => mode === 'risk' ? formatCurrency(v, currency, true) : String(Math.round(v))
  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(v)}`).join(' ')
  const areaPath = `${linePath} L ${xFor(values.length - 1)} ${H - PAD} L ${xFor(0)} ${H - PAD} Z`
  const colour = mode === 'risk' ? 'var(--red)' : 'var(--amber)'

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 180, display: 'block' }}
        onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="portfolio-trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity="0.16" />
            <stop offset="100%" stopColor={colour} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PADL} x2={W - PAD} y1={yFor(t)} y2={yFor(t)} stroke="var(--border)" strokeWidth="1" strokeDasharray={i === 2 ? undefined : '3 3'} opacity={0.7} />
            <text x={PADL - 6} y={yFor(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-4)">{fmtTick(t)}</text>
          </g>
        ))}
        <path d={areaPath} fill="url(#portfolio-trend-fill)" />
        <path d={linePath} fill="none" stroke={colour} strokeWidth="1.75" />
        {values.map((v, i) => (
          <rect key={i} x={xFor(i) - (W / points.length) / 2} y={0} width={W / points.length} height={H}
            fill="transparent" onMouseEnter={() => setHover(i)} style={{ cursor: 'pointer' }} />
        ))}
        {hover !== null && (
          <>
            <line x1={xFor(hover)} y1={0} x2={xFor(hover)} y2={H} stroke="var(--border)" strokeWidth="1" />
            <circle cx={xFor(hover)} cy={yFor(values[hover])} r="3.5" fill={colour} />
          </>
        )}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-4)', marginTop: 2, paddingLeft: `${(PADL / W) * 100}%` }}>
        <span>{formatDate(points[0].date)}</span>
        <span>{formatDate(points[points.length - 1].date)}</span>
      </div>
      {hover !== null && (
        <div style={{
          position: 'absolute', top: 4, left: 4, background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 11.5, boxShadow: '0 4px 12px rgba(0,0,0,.08)',
        }}>
          <div style={{ color: 'var(--text-3)', marginBottom: 2 }}>{formatDate(points[hover].date)}</div>
          <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>
            {mode === 'risk'
              ? formatCurrency(points[hover].contractValueAtRisk ?? 0, currency, true)
              : `${points[hover].openFlagsCount} open flag${points[hover].openFlagsCount !== 1 ? 's' : ''}`}
          </div>
        </div>
      )}
    </div>
  )
}

// ── SEVERITY BREAKDOWN ───────────────────────────────────────────
function SeverityBreakdown({ breakdown }: { breakdown: { high: number; medium: number; low: number } }) {
  const total = breakdown.high + breakdown.medium + breakdown.low
  if (total === 0) {
    return <p style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No open flags right now.</p>
  }
  return (
    <div>
      <div style={{ display: 'flex', height: 10, borderRadius: 99, overflow: 'hidden', marginBottom: 14 }}>
        {(['high', 'medium', 'low'] as const).map(s => breakdown[s] > 0 && (
          <div key={s} style={{ width: `${(breakdown[s] / total) * 100}%`, background: SEVERITY_META[s].colour }} />
        ))}
      </div>
      {(['high', 'medium', 'low'] as const).map(s => (
        <div key={s} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, fontSize: 12.5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_META[s].colour, display: 'inline-block' }} />
            <span style={{ color: 'var(--text-2)' }}>{SEVERITY_META[s].label}</span>
          </div>
          <span style={{ fontWeight: 600, color: 'var(--text-1)' }}>{breakdown[s]}</span>
        </div>
      ))}
    </div>
  )
}

// ── DOCUMENTS NEEDING ACTION ─────────────────────────────────────
// Was "Stalled documents": only SOWs/COs that had gone quiet. A SOW the client DECLINED, a link that EXPIRED,
// a counter-offer waiting on the agency — the Dashboard's Needs-attention register already lists all of those,
// and this portfolio view (the one a principal reads to see where the agency is stuck) left them out. Same
// states, same "current SOW only" rule. The first 8 show by default; the rest expand.
const STALLED_PREVIEW_COUNT = 8

// Deep-links into the SOW / CO tab of the project (not just its overview) and
// degrades to a plain row for members who can't open every project.
function StalledRow({ href, children }: { href: string | null; children: React.ReactNode }) {
  const style: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--surface-2)', textDecoration: 'none' }
  return href ? <Link href={href} style={style}>{children}</Link> : <div style={style}>{children}</div>
}

const REASON_PILL: Record<string, string> = {
  'SOW unsigned': 'red', Stalled: 'red', Declined: 'red', Expired: 'red', 'Changes requested': 'amber', 'Counter-offer': 'amber',
}

function StalledPanel({ docs, canViewFinancials, canOpenProjects }: { docs: StuckDoc[]; canViewFinancials: boolean; canOpenProjects: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? docs : docs.slice(0, STALLED_PREVIEW_COUNT)
  const hiddenCount = docs.length - visible.length

  return (
    <div className="surface surface-p">
      <div className="sec-hd" style={{ marginBottom: 14 }}>
        <div className="sec-title">Documents needing action ({docs.length})</div>
      </div>
      {docs.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Nothing stalled, declined or expired across the portfolio.</p>
      ) : (
        <>
          {visible.map((item, i) => (
            <StalledRow key={`${item.kind}-${item.projectId}-${item.title}-${i}`}
              href={canOpenProjects ? `/projects/${item.projectId}?tab=${item.kind === 'SOW' ? 'sow' : 'co'}` : null}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className={`pill pill-${REASON_PILL[item.reason] || 'slate'} pill-sm`}>{item.kind} · {item.reason}</span>
                  <span style={{ fontSize: 13, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.kind === 'CO' ? item.title : item.projectName}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  {item.kind === 'CO' ? item.projectName : ''}{item.clientName ? `${item.kind === 'CO' ? ' · ' : ''}${item.clientName}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
                {/* A genuine $0 total shows as $0 (an explicit null check, not a truthy one). */}
                {canViewFinancials && item.total != null ? (
                  <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{formatCurrency(item.total, item.currency || 'USD')}</div>
                ) : null}
                <div style={{ fontSize: 10.5, color: 'var(--text-4)' }}>since {formatRelative(item.since)}</div>
              </div>
            </StalledRow>
          ))}
          {(hiddenCount > 0 || expanded) && docs.length > STALLED_PREVIEW_COUNT && (
            <button
              className="btn btn-ghost btn-xs"
              style={{ marginTop: 10 }}
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? 'Show less' : `Show ${hiddenCount} more`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── EXCEPTIONS PANEL ─────────────────────────────────────────────
// Was a count, a dollar figure and a link to a page that (a) needs VIEW_ALL_PROJECTS, which a portfolio-only
// viewer doesn't have — a dead end for exactly the people this page is for — and (b) is a top-8 table, not a
// log. The newest exceptions are listed here now; the link is only shown to people who can use it.
const EXC_PREVIEW = 5
function ExceptionsPanel({ count, value, items, total, canViewFinancials, canOpenProjects, currency }: {
  count: number; value: number | null; items: ExceptionItem[]; total: number
  canViewFinancials: boolean; canOpenProjects: boolean; currency: string
}) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items.slice(0, EXC_PREVIEW)
  return (
    <div className="surface surface-p">
      <div className="sec-hd" style={{ marginBottom: 14 }}>
        <div className="sec-title">Exceptions granted, all-time</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <div className="mc-val" style={{ fontSize: 32 }}>{count}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>scope items waived across the portfolio</div>
      </div>
      {canViewFinancials && value !== null && (
        <p style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
          Representing <strong>{formatCurrency(value, currency, true)}</strong> in scope given away
          outside a change order — worth reviewing if this trends upward.
        </p>
      )}
      {visible.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {visible.map(e => (
            <StalledRow key={e.id} href={canOpenProjects ? `/projects/${e.projectId}?tab=guardian` : null}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.grantedWhat}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{e.projectName}{e.clientName ? ` · ${e.clientName}` : ''}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
                {canViewFinancials && e.estimatedValue !== null && (
                  <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{formatCurrency(e.estimatedValue, e.currency)}</div>
                )}
                <div style={{ fontSize: 10.5, color: 'var(--text-4)' }}>{formatRelative(e.createdAt)}</div>
              </div>
            </StalledRow>
          ))}
          {items.length > EXC_PREVIEW && (
            <button className="btn btn-ghost btn-xs" style={{ marginTop: 10 }} onClick={() => setExpanded(v => !v)}>
              {expanded ? 'Show less' : `Show ${items.length - EXC_PREVIEW} more`}
            </button>
          )}
          {total > items.length && (
            <p style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 8 }}>Newest {items.length} of {total} — the CSV export lists all of them.</p>
          )}
        </div>
      )}
      {canOpenProjects && (
        <Link href="/reports?mode=scope" style={{ fontSize: 11.5, color: 'var(--green)', display: 'inline-block', marginTop: 8 }}>
          Open scope reports →
        </Link>
      )}
    </div>
  )
}

// ── HOW THE RISK NUMBER IS CALCULATED ────────────────────────────
// The tile said "Severity-weighted estimate" and nothing else. The constants come from the API (riskModel), so
// this text can never drift from the maths in lib/reports/scope-health.ts.
function RiskExplainer({ model }: { model: PortfolioData['riskModel'] }) {
  const pct = Math.round(model.openFlagRate * 1000) / 10
  const m = model.severityMultipliers
  return (
    <details style={{ margin: '-8px 0 20px', fontSize: 12, color: 'var(--text-3)' }}>
      <summary style={{ cursor: 'pointer', color: 'var(--text-2)' }}>How is “contract value at risk” calculated?</summary>
      <div style={{ marginTop: 8, lineHeight: 1.55, maxWidth: 760 }}>
        <p style={{ margin: '0 0 6px' }}>
          Each <strong>open</strong> scope flag puts {pct}% of its project&apos;s contract value at risk, weighted by severity
          (High ×{m.high}, Medium ×{m.medium}, Low ×{m.low}). A project&apos;s flag exposure is capped at 100% of its value.
        </p>
        <p style={{ margin: '0 0 6px' }}>
          Exceptions granted on projects still in progress add their estimated value (weighted by the severity of the flag they resolved).
          Completed and archived projects never count, and flags awaiting Guardian review aren&apos;t counted until confirmed.
        </p>
        <p style={{ margin: 0 }}>
          “Contract value” is the agreed value plus accepted change orders — for a retainer, the monthly amount × its months
          (an open-ended retainer counts the months contracted so far). It&apos;s an estimate of exposure, not a forecast.
          The “Projects by risk” table below shows where the total comes from.
        </p>
      </div>
    </details>
  )
}

// ── PROJECTS BY RISK ─────────────────────────────────────────────
// The page gave a workspace-wide total and no way to see WHICH projects it came from. The per-project rows
// already existed inside computeScopeHealth; this surfaces them, sorted by exposure, with a by-client roll-up.
const RISK_PREVIEW = 10

function ProjectsByRisk({ rows, canViewFinancials, canOpenProjects }: { rows: RiskRow[]; canViewFinancials: boolean; canOpenProjects: boolean }) {
  const router = useRouter()
  const [view, setView] = useState<'project' | 'client'>('project')
  const [expanded, setExpanded] = useState(false)
  const hasClients = rows.some(r => r.clientName)

  const clientRows = useMemo(() => {
    const map = new Map<string, { client: string; projects: number; openFlags: number; highFlags: number; stuckDocs: number; risk: Map<string, number> }>()
    for (const r of rows) {
      const key = r.clientName || 'No client'
      const g = map.get(key) || { client: key, projects: 0, openFlags: 0, highFlags: 0, stuckDocs: 0, risk: new Map<string, number>() }
      g.projects++; g.openFlags += r.openFlags; g.highFlags += r.highFlags; g.stuckDocs += r.stuckDocs
      if (r.atRisk !== null) g.risk.set(r.currency, (g.risk.get(r.currency) || 0) + r.atRisk)
      map.set(key, g)
    }
    const sum = (g: { risk: Map<string, number> }) => Array.from(g.risk.values()).reduce((a, b) => a + b, 0)
    return Array.from(map.values()).sort((a, b) => sum(b) - sum(a) || b.openFlags - a.openFlags || a.client.localeCompare(b.client))
  }, [rows])

  const list = view === 'project' ? rows : clientRows
  const visibleCount = expanded ? list.length : Math.min(list.length, RISK_PREVIEW)

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="sec-hd">
        <div className="sec-title">Projects by risk ({rows.length})</div>
        {hasClients && (
          <div style={{ display: 'flex', gap: 4 }}>
            {(['project', 'client'] as const).map(v => (
              <button key={v} className={`btn btn-xs ${view === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setView(v); setExpanded(false) }}>
                {v === 'project' ? 'By project' : 'By client'}
              </button>
            ))}
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="surface">
          <div className="empty-state" style={{ padding: '28px 24px' }}>
            <i className="ti ti-shield-check empty-state-icon" />
            <p className="empty-state-title">No project is carrying risk</p>
            <p className="empty-state-sub">No open flags, exceptions or stuck documents on any project in progress.</p>
          </div>
        </div>
      ) : (
        <div className="surface" style={{ overflow: 'hidden' }}>
          <table className="gov-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{view === 'project' ? 'Project' : 'Client'}</th>
                {view === 'client' && <th>Projects</th>}
                <th>Open flags</th>
                <th>Stuck docs</th>
                {canViewFinancials && <th style={{ textAlign: 'right' }}>Value at risk</th>}
              </tr>
            </thead>
            <tbody>
              {view === 'project'
                ? rows.slice(0, visibleCount).map(r => (
                    <tr key={r.projectId}
                      style={canOpenProjects ? { cursor: 'pointer' } : undefined}
                      onClick={canOpenProjects ? () => router.push(`/projects/${r.projectId}?tab=guardian`) : undefined}>
                      <td>
                        <div className="td-primary">{r.projectName}</div>
                        {r.clientName && <div className="td-sub">{r.clientName}</div>}
                      </td>
                      <td>
                        {r.openFlags}{r.highFlags > 0 && <span style={{ color: 'var(--red)', fontSize: 11.5 }}> ({r.highFlags} high)</span>}
                        {r.borderlineFlags > 0 && <div className="td-sub">+{r.borderlineFlags} awaiting review</div>}
                      </td>
                      <td>{r.stuckDocs || '—'}</td>
                      {canViewFinancials && (
                        <td className="td-mono" style={{ textAlign: 'right' }}>
                          {r.atRisk !== null ? formatCurrency(r.atRisk, r.currency) : '—'}
                          {r.exceptionsCount > 0 && <div className="td-sub">{r.exceptionsCount} exception{r.exceptionsCount === 1 ? '' : 's'}</div>}
                        </td>
                      )}
                    </tr>
                  ))
                : clientRows.slice(0, visibleCount).map(g => (
                    <tr key={g.client}>
                      <td className="td-primary">{g.client}</td>
                      <td>{g.projects}</td>
                      <td>{g.openFlags}{g.highFlags > 0 && <span style={{ color: 'var(--red)', fontSize: 11.5 }}> ({g.highFlags} high)</span>}</td>
                      <td>{g.stuckDocs || '—'}</td>
                      {canViewFinancials && (
                        <td className="td-mono" style={{ textAlign: 'right' }}>
                          {g.risk.size === 0 ? '—' : Array.from(g.risk.entries()).map(([cur, v]) => formatCurrency(v, cur)).join(' · ')}
                        </td>
                      )}
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}
      {list.length > RISK_PREVIEW && (
        <button className="btn btn-ghost btn-xs" style={{ marginTop: 10 }} onClick={() => setExpanded(v => !v)}>
          {expanded ? 'Show less' : `Show all ${list.length}`}
        </button>
      )}
    </div>
  )
}
