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
interface StalledSow { projectId: string; projectName: string; clientName: string | null; since: string }
interface StalledCo { id: string; title: string; total: number | null; currency: string; projectId: string; projectName: string; since: string }

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
  stalledSows: StalledSow[]
  stalledCos: StalledCo[]
  hasSnapshots: boolean
}

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

  const filteredFlags = useMemo(() => {
    if (!data) return []
    return flagFilter === 'all' ? data.openFlags : data.openFlags.filter(f => f.severity === flagFilter)
  }, [data, flagFilter])

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
            <StalledPanel sows={data.stalledSows} cos={data.stalledCos} canViewFinancials={canViewFinancials} canOpenProjects={canOpenProjects} />
            <ExceptionsPanel
              count={data.current.exceptionsCount}
              value={data.current.exceptionsValueTotal}
              canViewFinancials={canViewFinancials}
              currency={data.currency}
            />
          </div>

          <div>
            <div className="sec-hd">
              <div className="sec-title">Open scope flags ({data.openFlags.length}{data.openFlagsTotal && data.openFlagsTotal > data.openFlags.length ? ` of ${data.openFlagsTotal} · highest severity first` : ''})</div>
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
                  <p className="empty-state-sub">Scope is under control across the portfolio right now.</p>
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
        <div className="mc-sub">{c.stalledSowCount} SOW · {c.stalledCoCount} CO</div>
      </div>
    </div>
  )
}

// ── TREND CHART (hand-rolled SVG — no charting dependency) ──────────
function TrendChart({ points: allPoints, mode, currency }: { points: HistoryPoint[]; mode: 'risk' | 'flags'; currency: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 640, H = 180, PAD = 8

  // FIX (fix round, Portfolio section 8): in risk mode, a point whose own
  // currency didn't match today's dominant one arrives with
  // contractValueAtRisk already nulled (see getPortfolioData) — drop it from
  // the line entirely rather than coercing it to 0, which would draw a day
  // with a currency mismatch as a day with zero risk. Flag-count mode has no
  // currency concept, so every point is always kept.
  const points = mode === 'risk' ? allPoints.filter(p => p.contractValueAtRisk !== null) : allPoints

  const values = points.map(p => mode === 'risk' ? (p.contractValueAtRisk ?? 0) : p.openFlagsCount)
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1

  if (points.length < 2) {
    return <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '40px 0', textAlign: 'center' }}>
      Not enough history yet — check back after a few daily rollups.
    </div>
  }

  const xFor = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2)
  const yFor = (v: number) => H - PAD - ((v - min) / range) * (H - PAD * 2)

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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-4)', marginTop: 2 }}>
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

// ── STALLED DOCUMENTS ────────────────────────────────────────────
// FIX (deep audit, section 8 — feature gap): this used to hard-truncate
// to the first 8 items with no way to see the rest — a portfolio with
// more than 8 stalled documents combined lost the remainder with no
// count, no "view all", nothing. Neither the API route nor the query
// behind it actually caps the list (only this component's own .slice()
// did), so the data was already there; only the affordance to see past
// it was missing. Show 8 by default and let the person expand to the
// full list, same shape as the "show all" pattern elsewhere in the UI.
const STALLED_PREVIEW_COUNT = 8

// Deep-links into the SOW / CO tab of the project (not just its overview) and
// degrades to a plain row for members who can't open every project.
function StalledRow({ href, children }: { href: string | null; children: React.ReactNode }) {
  const style: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--surface-2)', textDecoration: 'none' }
  return href ? <Link href={href} style={style}>{children}</Link> : <div style={style}>{children}</div>
}

function StalledPanel({ sows, cos, canViewFinancials, canOpenProjects }: { sows: StalledSow[]; cos: StalledCo[]; canViewFinancials: boolean; canOpenProjects: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const items = [
    ...sows.map(s => ({ kind: 'SOW' as const, id: s.projectId, title: s.projectName, sub: s.clientName, since: s.since, projectId: s.projectId, amount: null as number | null, currency: null as string | null })),
    // FIX (deep audit, section 8): each CO now carries its own project's
    // currency instead of borrowing the single workspace-wide dominant
    // one — see the fix note on StalledCo / the API route.
    ...cos.map(c => ({ kind: 'CO' as const, id: c.id, title: c.title, sub: c.projectName, since: c.since, projectId: c.projectId, amount: c.total, currency: c.currency })),
  ].sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime())

  const visible = expanded ? items : items.slice(0, STALLED_PREVIEW_COUNT)
  const hiddenCount = items.length - visible.length

  return (
    <div className="surface surface-p">
      <div className="sec-hd" style={{ marginBottom: 14 }}>
        <div className="sec-title">Stalled documents ({items.length})</div>
      </div>
      {items.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Nothing stalled across the portfolio.</p>
      ) : (
        <>
          {visible.map(item => (
            <StalledRow key={`${item.kind}-${item.id}`}
              href={canOpenProjects ? `/projects/${item.projectId}?tab=${item.kind === 'SOW' ? 'sow' : 'co'}` : null}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="pill pill-red pill-sm">{item.kind}</span>
                  <span style={{ fontSize: 13, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                </div>
                {item.sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{item.sub}</div>}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
                {/* FIX (fix round, Portfolio section 8): same $0-hidden-as-truthy-check
                    issue as the open-flags table above — a net-zero change order would
                    silently show no amount here while the CSV listed it as 0. */}
                {canViewFinancials && item.amount != null ? (
                  <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{formatCurrency(item.amount, item.currency || 'USD')}</div>
                ) : null}
                <div style={{ fontSize: 10.5, color: 'var(--text-4)' }}>since {formatRelative(item.since)}</div>
              </div>
            </StalledRow>
          ))}
          {(hiddenCount > 0 || expanded) && items.length > STALLED_PREVIEW_COUNT && (
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
function ExceptionsPanel({ count, value, canViewFinancials, currency }: { count: number; value: number | null; canViewFinancials: boolean; currency: string }) {
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
      <Link href="/reports?mode=scope" style={{ fontSize: 11.5, color: 'var(--green)', display: 'inline-block', marginTop: 4 }}>
        View exception log →
      </Link>
    </div>
  )
}
