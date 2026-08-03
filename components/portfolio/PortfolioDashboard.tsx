'use client'
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { formatCurrency, formatDate, formatRelative } from '@/lib/utils/format'

type Period = '30d' | '90d' | '6m' | '12m'

interface HistoryPoint {
  date: string
  openFlagsCount: number
  contractValueAtRisk: number | null
  exceptionsCount: number
}
interface OpenFlag {
  id: string; severity: 'high' | 'medium' | 'low'; description: string; sowReference: string
  createdAt: string; projectId: string; projectName: string; clientName: string | null
  contractValue: number | null; currency: string
}
interface StalledSow { projectId: string; projectName: string; clientName: string | null; since: string }
interface StalledCo { id: string; title: string; total: number | null; projectId: string; projectName: string; since: string }

interface PortfolioData {
  currency: string
  current: {
    openFlagsCount: number
    openFlagsBySeverity: { high: number; medium: number; low: number }
    exceptionsCount: number
    exceptionsValueTotal: number | null
    contractValueAtRisk: number | null
    stalledSowCount: number
    stalledCoCount: number
    activeProjectCount: number
    snapshotDate: string
  } | null
  history: HistoryPoint[]
  trend: { openFlagsDelta: number; atRiskDelta: number } | null
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
]

const SEVERITY_META: Record<string, { label: string; colour: string }> = {
  high: { label: 'High', colour: 'var(--red)' },
  medium: { label: 'Medium', colour: 'var(--amber)' },
  low: { label: 'Low', colour: 'var(--text-4)' },
}

export default function PortfolioDashboard({ canViewFinancials, agencyName }: { canViewFinancials: boolean; agencyName: string }) {
  const [period, setPeriod] = useState<Period>('90d')
  const [data, setData] = useState<PortfolioData | null>(null)
  const [loading, setLoading] = useState(true)
  const [flagFilter, setFlagFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all')

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/portfolio?period=${period}`)
      .then(r => r.json())
      .then(json => { setData(json); setLoading(false) })
      .catch(() => setLoading(false))
  }, [period])

  const filteredFlags = useMemo(() => {
    if (!data) return []
    return flagFilter === 'all' ? data.openFlags : data.openFlags.filter(f => f.severity === flagFilter)
  }, [data, flagFilter])

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">
            Scope-governance rollup across every project · {agencyName}
          </p>
        </div>
        <select className="finp" style={{ width: 'auto' }} value={period}
          onChange={e => setPeriod(e.target.value as Period)}>
          {PERIODS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <span className="spin spin-dark" style={{ width: 24, height: 24 }} />
        </div>
      ) : !data || !data.hasSnapshots ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-building-skyscraper empty-state-icon" />
            <p className="empty-state-title">No portfolio history yet</p>
            <p className="empty-state-sub">
              The scope-health rollup runs once a day. Come back tomorrow, or check that at least
              one project has activity — this view is built from that daily snapshot.
            </p>
          </div>
        </div>
      ) : (
        <>
          <MetricStrip data={data} canViewFinancials={canViewFinancials} />

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
            </div>

            <div className="surface surface-p">
              <div className="sec-hd" style={{ marginBottom: 16 }}>
                <div className="sec-title">Open flags by severity</div>
              </div>
              <SeverityBreakdown breakdown={data.current!.openFlagsBySeverity} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start', marginBottom: 24 }}>
            <StalledPanel sows={data.stalledSows} cos={data.stalledCos} canViewFinancials={canViewFinancials} currency={data.currency} />
            <ExceptionsPanel
              count={data.current!.exceptionsCount}
              value={data.current!.exceptionsValueTotal}
              canViewFinancials={canViewFinancials}
              currency={data.currency}
            />
          </div>

          <div>
            <div className="sec-hd">
              <div className="sec-title">Open scope flags ({data.openFlags.length})</div>
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
                      <tr key={f.id} onClick={() => window.location.href = `/projects/${f.projectId}?tab=guardian`}>
                        <td>
                          <div className="td-primary">{f.projectName}</div>
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
                            {SEVERITY_META[f.severity].label}
                          </span>
                        </td>
                        {canViewFinancials && (
                          <td className="td-mono" style={{ textAlign: 'right' }}>
                            {f.contractValue ? formatCurrency(f.contractValue, f.currency) : '—'}
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
  const c = data.current!
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
          {canViewFinancials && trend
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
function TrendChart({ points, mode, currency }: { points: HistoryPoint[]; mode: 'risk' | 'flags'; currency: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 640, H = 180, PAD = 8

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
function StalledPanel({ sows, cos, canViewFinancials, currency }: { sows: StalledSow[]; cos: StalledCo[]; canViewFinancials: boolean; currency: string }) {
  const items = [
    ...sows.map(s => ({ kind: 'SOW' as const, id: s.projectId, title: s.projectName, sub: s.clientName, since: s.since, projectId: s.projectId, amount: null as number | null })),
    ...cos.map(c => ({ kind: 'CO' as const, id: c.id, title: c.title, sub: c.projectName, since: c.since, projectId: c.projectId, amount: c.total })),
  ].sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime())

  return (
    <div className="surface surface-p">
      <div className="sec-hd" style={{ marginBottom: 14 }}>
        <div className="sec-title">Stalled documents ({items.length})</div>
      </div>
      {items.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Nothing stalled across the portfolio.</p>
      ) : (
        items.slice(0, 8).map(item => (
          <Link key={`${item.kind}-${item.id}`} href={`/projects/${item.projectId}`}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--surface-2)', textDecoration: 'none' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="pill pill-red pill-sm">{item.kind}</span>
                <span style={{ fontSize: 13, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
              </div>
              {item.sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{item.sub}</div>}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
              {canViewFinancials && item.amount ? (
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{formatCurrency(item.amount, currency)}</div>
              ) : null}
              <div style={{ fontSize: 10.5, color: 'var(--text-4)' }}>since {formatRelative(item.since)}</div>
            </div>
          </Link>
        ))
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
