'use client'
import { useState, useEffect } from 'react'
import { formatCurrency, formatDate } from '@/lib/utils/format'

type Mode   = 'scope' | 'financial'
type Period = '30d' | '90d' | '6m' | '12m' | 'all'

export default function ReportsPage() {
  const [mode,    setMode]    = useState<Mode>('scope')
  const [period,  setPeriod]  = useState<Period>('90d')
  const [currency, setCurrency] = useState<string>('')
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const currencyParam = currency ? `&currency=${currency}` : ''
    fetch(`/api/reports?mode=${mode}&period=${period}${currencyParam}`)
      .then(r => r.json())
      .then(json => {
        setData(json)
        // Lock in whichever currency the backend resolved to, so the
        // selector reflects reality and subsequent fetches stay pinned.
        if (json.currency && !currency) setCurrency(json.currency)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [mode, period, currency])

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
            <select className="finp" style={{ width: 'auto' }} value={currency}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCurrency(e.target.value)}>
              {(data.availableCurrencies || []).map((c: string) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <select className="finp" style={{ width: 'auto' }} value={period}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPeriod(e.target.value as Period)}>
            {PERIODS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
      </div>

      {data?.mixedCurrencies && (
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16, fontSize: 12.5, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 14, color: 'var(--text-3)' }} />
          You have projects in multiple currencies ({(data.availableCurrencies || []).join(', ')}). Figures below are shown in <strong>{currency}</strong> only — switch currencies above to see the rest. Totals are never combined across currencies.
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
          <div className="mc-sub">Out of scope detected</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Converted to CO</div>
          <div className="mc-val green">{metrics?.converted_to_co ?? 0}</div>
          <div className="mc-sub">Revenue captured</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Recovery rate</div>
          <div className="mc-val green">
            {metrics?.total_flags > 0
              ? `${Math.round((metrics.converted_to_co / metrics.total_flags) * 100)}%`
              : '—'}
          </div>
          <div className="mc-sub">Flags → accepted COs</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Recovered value</div>
          <div className="mc-val green">
            {metrics?.recovered_value > 0
              ? formatCurrency(metrics.recovered_value, currency || 'USD', true)
              : '—'}
          </div>
          <div className="mc-sub">From accepted COs</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
        {/* Flags by project */}
        <div className="surface surface-p">
          <div className="sec-hd" style={{ marginBottom: 16 }}>
            <div className="sec-title">Flags by project</div>
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
            <div className="sec-title">Exceptions granted</div>
            {(exceptionsByProject || []).length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {formatCurrency(
                  (exceptionsByProject || []).reduce((s: number, e: any) => s + (e.estimated_value || 0), 0),
                  currency || 'USD', true
                )} total estimated
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
                      {formatCurrency(ex.estimated_value, currency || 'USD')}
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
            <div className="sec-title">Scope adjustments ({(adjustments || []).length})</div>
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
          <div className="mc-lbl">Effective contract value</div>
          <div className="mc-val green">
            {formatCurrency(metrics?.effective_value || 0, currency || 'USD', true)}
          </div>
          <div className="mc-sub">Base + amendments</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">CO impact</div>
          <div className="mc-val green">
            {formatCurrency(metrics?.co_impact || 0, currency || 'USD', true)}
          </div>
          <div className="mc-sub">From accepted change orders</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">COs raised</div>
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
            <div className="sec-title">Revenue by client</div>
          </div>
          {!(byClient || []).length ? (
            <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No data in this period</p>
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
            <div className="sec-title">Revenue by project type</div>
          </div>
          {!(byType || []).length ? (
            <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No data in this period</p>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
            {[
              { label: 'Raised', val: coGrid.raised,   color: 'var(--text)' },
              { label: 'Accepted', val: coGrid.accepted, color: 'var(--green)' },
              { label: 'Declined', val: coGrid.declined, color: 'var(--red)' },
              { label: 'Pending', val: coGrid.pending,  color: 'var(--amber)' },
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
