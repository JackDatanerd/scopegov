'use client'
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { formatCurrency, formatDate } from '@/lib/utils/format'

type Mode   = 'scope' | 'financial'
type Period = '30d' | '90d' | '6m' | '12m' | 'all'

// FIX (deep audit, section 8 follow-up): this page never read `?mode=`
// from the URL at all — `mode` always initialized to the hardcoded
// default 'scope' regardless of what was in the address bar. The
// Portfolio dashboard's "View exception log →" link
// (components/portfolio/PortfolioDashboard.tsx) passes `?mode=scope`,
// which happened to look like it worked only because the default already
// agreed with it — the query param itself did nothing. Any other caller
// linking here with `?mode=financial` would silently land on Scope
// anyway. Wrapped in Suspense per Next's requirement for useSearchParams
// (see app/(app)/projects/new/page.tsx for the same pattern already used
// in this codebase).
export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsPageInner />
    </Suspense>
  )
}

function ReportsPageInner() {
  const searchParams = useSearchParams()
  const initialMode: Mode = searchParams.get('mode') === 'financial' ? 'financial' : 'scope'
  const [mode,    setMode]    = useState<Mode>(initialMode)
  const [period,  setPeriod]  = useState<Period>('90d')
  const [currency, setCurrency] = useState<string>('')
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  // FIX (deep audit, Reports & Audit re-pass): the fetch below never
  // checked `res.ok` — a 403 (missing VIEW_ALL_PROJECTS, or VIEW_FINANCIALS
  // on the financial tab) or a genuine 500 both return a truthy
  // `{error: '...'}` body, which used to be handed straight to `setData`.
  // Every metric then destructured to `undefined` and rendered as if the
  // workspace genuinely had zero flags/exceptions/adjustments — a
  // permission-denied user saw what looked like a clean bill of health
  // instead of being told they can't see this page. `errorMsg` now
  // distinguishes "no permission" / "failed to load" from "genuinely
  // empty", and the Reports nav link itself is now gated behind
  // VIEW_ALL_PROJECTS in Sidebar.tsx so this is a true defense-in-depth
  // case, not the only line of defense.
  const [errorMsg, setErrorMsg] = useState('')
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null)
  const [exportError, setExportError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErrorMsg('')
    const currencyParam = currency ? `&currency=${encodeURIComponent(currency)}` : ''
    fetch(`/api/reports?mode=${mode}&period=${period}${currencyParam}`)
      .then(async res => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setData(null)
          setErrorMsg(json.error || 'Could not load report data.')
          return
        }
        // FIX (Reports & Audit re-pass #3): `currency` is now only the
        // currency the person REQUESTED. The dropdown displays whatever the
        // backend resolved (`data.currency`), so it can never drift from
        // the numbers on screen — and there is no longer a setCurrency()
        // here. That call changed an effect dependency, so every first load
        // and every tab switch fetched twice (the '' -> 'USD' resync
        // re-triggered this effect), doubling the five 5,000-row queries.
        setData(json)
      })
      .catch(() => { if (!cancelled) setErrorMsg('Could not load report data.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [mode, period, currency])

  async function handleExport(format: 'csv' | 'pdf') {
    setExporting(format); setExportError('')
    try {
      // Export the currency actually on screen, not merely the requested one.
      const shown = data?.currency || currency
      const currencyParam = shown ? `&currency=${encodeURIComponent(shown)}` : ''
      const res = await fetch(`/api/reports/export?mode=${mode}&period=${period}&format=${format}${currencyParam}`)
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Export failed') }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') || ''
      const match = disposition.match(/filename="([^"]+)"/)
      const filename = match?.[1] || `${mode}-report.${format}`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : 'Export failed')
    } finally { setExporting(null) }
  }

  const PERIODS: { key: Period; label: string }[] = [
    { key: '30d',  label: 'Last 30 days' },
    { key: '90d',  label: 'Last 90 days' },
    { key: '6m',   label: '6 months' },
    { key: '12m',  label: '12 months' },
    { key: 'all',  label: 'All time' },
  ]

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">Scope governance and financial performance</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {data?.mixedCurrencies && (
            <select className="finp" style={{ width: 'auto' }} value={data.currency || currency}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCurrency(e.target.value)}>
              {(data.availableCurrencies || []).map((c: string) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <select className="finp" style={{ width: 'auto' }} value={period}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPeriod(e.target.value as Period)}>
            {PERIODS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          {/* FEATURE (deep audit, Reports & Audit re-pass): this page had
              no export at all — see api/reports/export/route.ts. */}
          <button className="btn btn-ghost btn-sm" disabled={!data || exporting !== null || loading} onClick={() => handleExport('csv')}>
            {exporting === 'csv' ? <span className="spin" /> : <><i className="ti ti-file-spreadsheet" style={{ marginRight: 6 }} />CSV</>}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={!data || exporting !== null || loading} onClick={() => handleExport('pdf')}>
            {exporting === 'pdf' ? <span className="spin" /> : <><i className="ti ti-file-type-pdf" style={{ marginRight: 6 }} />PDF</>}
          </button>
        </div>
      </div>

      {exportError && <div className="auth-error" style={{ marginBottom: 16 }}>{exportError}</div>}

      {data?.mixedCurrencies && (
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16, fontSize: 12.5, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 14, color: 'var(--text-3)' }} />
          You have projects in multiple currencies ({(data.availableCurrencies || []).join(', ')}). Figures below are shown in <strong>{data.currency}</strong> only — switch currencies above to see the rest. Totals are never combined across currencies.
        </div>
      )}

      {/* FIX (deep audit, Reports & Audit re-pass — CRITICAL): lib/reports/
          scope-financial-data.ts now caps every query at 5,000 rows and
          reports `truncated` when a workspace's data exceeds that in the
          selected period — previously these totals could be silently
          short with no signal anywhere. Surface it the same way the
          mixed-currencies notice above already does. */}
      {data?.truncated && (
        <div className="auth-error" style={{ marginBottom: 16 }}>
          This report is based on a large volume of data for the selected period and may be undercounting some
          figures. Narrow the date range for a fully accurate total.
        </div>
      )}

      {/* Mode toggle */}
      <div className="reports-mode-tabs">
        <button className={`rmt${mode === 'scope' ? ' active' : ''}`} onClick={() => setMode('scope')}>
          <i className="ti ti-shield-bolt" style={{ fontSize: 13, marginRight: 5 }} />Scope protection
        </button>
        <button className={`rmt${mode === 'financial' ? ' active' : ''}`} onClick={() => setMode('financial')}>
          <i className="ti ti-chart-bar" style={{ fontSize: 13, marginRight: 5 }} />Financial overview
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <span className="spin spin-dark" style={{ width: 24, height: 24 }} />
        </div>
      ) : errorMsg ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-lock empty-state-icon" />
            <p className="empty-state-title">{errorMsg}</p>
          </div>
        </div>
      ) : !data ? (
        <div className="surface"><div className="empty-state"><p className="empty-state-title">Could not load report data</p></div></div>
      ) : mode === 'scope' ? (
        <ScopeReport data={data} />
      ) : (
        <FinancialReport data={data} />
      )}
    </div>
  )
}

function ScopeReport({ data }: { data: any }) {
  const { metrics, flagsByProject, exceptionsByProject, adjustments, currency } = data

  const maxBarVal = Math.max(1, ...(flagsByProject || []).map((p: any) => p.flag_count))

  return (
    <div>
      {/* Metrics */}
      <div className="mstrip" style={{ marginBottom: 24 }}>
        <div className="mc">
          <div className="mc-lbl">Flags raised</div>
          <div className="mc-val red">{metrics?.total_flags ?? 0}</div>
          <div className="mc-sub">Confirmed out of scope{metrics?.dismissed_flags ? ` · ${metrics.dismissed_flags} dismissed` : ''}</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Converted to CO</div>
          <div className="mc-val green">{metrics?.converted_to_co ?? 0}</div>
          <div className="mc-sub">Change orders raised or accepted</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Recovery rate</div>
          <div className="mc-val green">
            {metrics?.total_flags > 0
              ? `${Math.round((metrics.converted_to_co / metrics.total_flags) * 100)}%`
              : '—'}
          </div>
          <div className="mc-sub">Flags → change orders</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Recovered value</div>
          <div className="mc-val green">
            {/* FIX (deep audit, Reports & Audit re-pass): `> 0 ? … : '—'`
                treated a genuine $0 recovered (permission held, nothing
                converted yet) identically to a redacted null (no
                VIEW_FINANCIALS) — both rendered '—' with no way to tell
                them apart. Same ambiguity class already fixed for the
                exceptions total just below; only a real null (redacted)
                should fall back to the placeholder. */}
            {metrics?.recovered_value == null
              ? '—'
              : formatCurrency(metrics.recovered_value, currency || 'USD', true)}
          </div>
          <div className="mc-sub">From accepted COs</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
        {/* Flags by project */}
        <div className="surface surface-p">
          <div className="sec-hd" style={{ marginBottom: 16 }}>
            <div className="sec-title">Flags by project</div>
            {(flagsByProject || []).length > 10 && (
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Top 10 of {(flagsByProject || []).length} · export for all</span>
            )}
          </div>
          {!(flagsByProject || []).length ? (
            <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No scope flags in this period</p>
          ) : (
            (flagsByProject || []).slice(0, 10).map((p: any) => (
              <div key={p.project_id} className="rbar-row">
                <div className="rbar-label" title={p.project_name}>{p.project_name}</div>
                <div className="rbar-track">
                  <div className="rbar-fill" style={{ width: `${(p.flag_count / maxBarVal) * 100}%`, background: 'var(--red)' }} />
                </div>
                <div className="rbar-value">{p.flag_count}</div>
              </div>
            ))
          )}
        </div>

        {/* Exceptions log */}
        <div className="surface surface-p">
          <div className="sec-hd" style={{ marginBottom: 16 }}>
            <div className="sec-title">Exceptions granted{(exceptionsByProject || []).length > 8 ? ` (showing 8 of ${(exceptionsByProject || []).length})` : ''}</div>
            {/* FIX (deep audit, Reports & Audit re-pass): estimated_value is
                redacted to null server-side for anyone without
                VIEW_FINANCIALS. Summing `e.estimated_value || 0` across an
                all-null list previously rendered a confident "$0 total
                estimated" — implying zero exposure rather than "hidden
                from you". Only show a total when at least one value
                actually came through; otherwise show the same "—"
                placeholder recovered_value uses (also fixed above — it
                had the identical null-vs-zero ambiguity, just less
                visibly since it's a single number rather than a sum). */}
            {(exceptionsByProject || []).length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {(exceptionsByProject || []).every((e: any) => e.estimated_value == null)
                  ? '—'
                  : `${formatCurrency(
                      (exceptionsByProject || []).reduce((s: number, e: any) => s + (e.estimated_value || 0), 0),
                      currency || 'USD', true
                    )} total estimated`}
              </span>
            )}
          </div>
          {!(exceptionsByProject || []).length ? (
            <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No exceptions granted in this period</p>
          ) : (
            <table className="gov-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Deliverable</th>
                  <th>Project</th>
                  <th style={{ textAlign: 'right' }}>Est. value</th>
                </tr>
              </thead>
              <tbody>
                {(exceptionsByProject || []).slice(0, 8).map((ex: any) => (
                  <tr key={ex.id}>
                    <td><div className="td-primary" style={{ fontSize: 12 }}>{ex.deliverable}</div></td>
                    <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{ex.projects?.name}</td>
                    <td className="td-mono" style={{ textAlign: 'right', fontSize: 12 }}>
                      {/* FIX (deep audit, Reports & Audit re-pass —
                          CRITICAL): estimated_value is null here for
                          anyone without VIEW_FINANCIALS, but this was
                          passed straight into formatCurrency() with no
                          guard — Intl.NumberFormat coerces null to 0, so
                          every row rendered a literal "$0", falsely
                          implying the exception carried no value at all
                          instead of being hidden. The aggregate total
                          right above already distinguishes this
                          correctly (`e.estimated_value == null`); the
                          per-row cell never did. The CSV export of this
                          same field (scopeToCsv in
                          api/reports/export/route.ts) already uses
                          `?? 'redacted'` — match that here instead of a
                          fabricated number. */}
                      {ex.estimated_value == null ? '—' : formatCurrency(ex.estimated_value, currency || 'USD')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Scope adjustments */}
      {(adjustments || []).length > 0 && (
        <div className="surface surface-p" style={{ marginTop: 20 }}>
          <div className="sec-hd" style={{ marginBottom: 14 }}>
            <div className="sec-title">Scope adjustments ({(adjustments || []).length}{(adjustments || []).length > 10 ? ' · showing 10, export for all' : ''})</div>
          </div>
          <table className="gov-table" style={{ width: '100%' }}>
            <thead><tr><th>Project</th><th>Deliverable change</th><th>Reason</th><th>Date</th></tr></thead>
            <tbody>
              {(adjustments || []).slice(0, 10).map((a: any) => (
                <tr key={a.id}>
                  <td style={{ fontSize: 13 }}>{a.projects?.name}</td>
                  <td>
                    <div style={{ fontSize: 11, color: 'var(--red)', textDecoration: 'line-through' }}>{a.old_value}</div>
                    <div style={{ fontSize: 11, color: 'var(--green)' }}>{a.new_value}</div>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{a.reason}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{formatDate(a.adjusted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function FinancialReport({ data }: { data: any }) {
  const { metrics, byClient, byType, coGrid, currency } = data
  const maxClient = Math.max(1, ...(byClient || []).map((c: any) => c.value))
  const maxType   = Math.max(1, ...(byType || []).map((t: any) => t.value))

  return (
    <div>
      {/* Metrics */}
      <div className="mstrip" style={{ marginBottom: 24 }}>
        <div className="mc">
          <div className="mc-lbl">Portfolio contract value</div>
          <div className="mc-val green">
            {formatCurrency(metrics?.effective_value || 0, currency || 'USD', true)}
          </div>
          <div className="mc-sub">Base + all accepted change orders</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Change orders added</div>
          <div className="mc-val green">
            {formatCurrency(metrics?.co_impact || 0, currency || 'USD', true)}
          </div>
          <div className="mc-sub">Accepted in this period</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">COs sent</div>
          <div className="mc-val">{metrics?.cos_raised ?? 0}</div>
          <div className="mc-sub">In period</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">CO acceptance rate</div>
          <div className="mc-val">
            {metrics?.cos_raised > 0
              ? `${Math.round((metrics.cos_accepted / metrics.cos_raised) * 100)}%`
              : '—'}
          </div>
          <div className="mc-sub">{metrics?.cos_accepted ?? 0} accepted</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
        {/* By client */}
        <div className="surface surface-p">
          <div className="sec-hd" style={{ marginBottom: 16 }}>
            <div className="sec-title">Contract value by client</div>
          </div>
          {!(byClient || []).length ? (
            <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No active projects in this currency</p>
          ) : (
            (byClient || []).slice(0, 10).map((c: any) => (
              <div key={c.client_id} className="rbar-row">
                <div className="rbar-label" title={c.client_name}>{c.client_name}</div>
                <div className="rbar-track">
                  <div className="rbar-fill" style={{ width: `${(c.value / maxClient) * 100}%`, background: 'var(--green)' }} />
                </div>
                <div className="rbar-value">{formatCurrency(c.value, currency || 'USD', true)}</div>
              </div>
            ))
          )}
        </div>

        {/* By project type */}
        <div className="surface surface-p">
          <div className="sec-hd" style={{ marginBottom: 16 }}>
            <div className="sec-title">Contract value by project type</div>
          </div>
          {!(byType || []).length ? (
            <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No active projects in this currency</p>
          ) : (
            (byType || []).map((t: any) => (
              <div key={t.type} className="rbar-row">
                <div className="rbar-label">{t.type_label}</div>
                <div className="rbar-track">
                  <div className="rbar-fill" style={{ width: `${(t.value / maxType) * 100}%`, background: 'var(--blue)' }} />
                </div>
                <div className="rbar-value">{formatCurrency(t.value, currency || 'USD', true)}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* CO impact grid */}
      {coGrid && (
        <div className="surface surface-p" style={{ marginTop: 20 }}>
          <div className="sec-hd" style={{ marginBottom: 14 }}>
            <div className="sec-title">Change order impact grid</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 1, background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
            {[
              { label: 'Sent', val: coGrid.raised,   color: 'var(--text)' },
              { label: 'Accepted', val: coGrid.accepted, color: 'var(--green)' },
              { label: 'Declined', val: coGrid.declined, color: 'var(--red)' },
              { label: 'Pending', val: coGrid.pending,  color: 'var(--amber)' },
              { label: 'Closed / expired', val: coGrid.closed, color: 'var(--text-3)' },
            ].map(item => (
              <div key={item.label} style={{ background: 'var(--surface)', padding: '16px 18px' }}>
                <div className="mc-lbl">{item.label}</div>
                <div className="mc-val" style={{ color: item.color }}>{item.val ?? 0}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
