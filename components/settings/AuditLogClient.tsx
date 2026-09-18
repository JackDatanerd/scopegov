'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { formatRelative } from '@/lib/utils/format'

interface Project { id: string; name: string }
interface Member { id: string; name: string; email: string; active: boolean }
interface Row {
  id?: string
  eventType: string
  entityType: string
  entityName: string | null
  actorName: string | null
  actorEmail: string
  createdAt: string
  ipAddress: string | null
}

function eventColour(type: string) {
  if (type.includes('signed') || type.includes('accepted') || type.includes('completed') || type.includes('joined') || type.includes('enabled')) return 'var(--green)'
  if (type.includes('declined') || type.includes('failed') || type.includes('stalled') || type.includes('deleted') || type.includes('disabled')) return 'var(--red)'
  if (type.includes('flag') || type.includes('guardian') || type.includes('escalated')) return 'var(--amber)'
  if (type.includes('billing') || type.includes('plan')) return 'var(--blue)'
  return 'var(--text-3)'
}

function isoDate(d: Date) { return d.toISOString().slice(0, 10) }

const RANGE_PRESETS = [
  { key: '30d',  label: 'Last 30 days',  days: 30 },
  { key: '90d',  label: 'Last 90 days',  days: 90 },
  { key: '12m',  label: 'Last 12 months', days: 365 },
  { key: 'custom', label: 'Custom range', days: 0 },
]

// FEATURE (deep audit, Reports & Audit re-pass — feature gap): the search
// box used to fire a fresh fetch on every keystroke — a `cancelled` guard
// prevented a slow, stale response from clobbering a newer one, but it did
// nothing to stop the request volume itself: typing a 10-character search
// term fired 10 requests. Debouncing is standard practice for exactly this
// kind of free-text filter and costs nothing in responsiveness a person
// would actually notice.
const SEARCH_DEBOUNCE_MS = 350

export default function AuditLogClient({ projects, members }: { projects: Project[]; members: Member[] }) {
  const today = useMemo(() => new Date(), [])
  const [preset, setPreset] = useState('90d')
  const [from, setFrom] = useState(isoDate(new Date(today.getTime() - 90 * 86400000)))
  const [to, setTo] = useState(isoDate(today))
  const [projectId, setProjectId] = useState('')
  const [actorId, setActorId] = useState('')
  // FEATURE (deep audit, Reports & Audit re-pass — feature gap): `qInput`
  // is what the text box is bound to (updates instantly, so typing never
  // feels laggy); `q` is the debounced value that actually drives the
  // fetch below.
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [qInput])

  const [rows, setRows] = useState<Row[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null)
  const [error, setError] = useState('')

  function applyPreset(key: string) {
    setPreset(key)
    const p = RANGE_PRESETS.find(r => r.key === key)
    if (p && p.days > 0) {
      setFrom(isoDate(new Date(today.getTime() - p.days * 86400000)))
      setTo(isoDate(today))
    }
  }

  const queryString = useCallback((format: string, offset?: number) => {
    const params = new URLSearchParams({ format, from, to })
    if (projectId) params.set('projectId', projectId)
    if (actorId) params.set('actorId', actorId)
    if (q.trim()) params.set('q', q.trim())
    if (offset) params.set('offset', String(offset))
    return params.toString()
  }, [from, to, projectId, actorId, q])

  // FEATURE (deep audit, Reports & Audit re-pass — feature gap): true
  // pagination. Any filter change starts over from offset 0 and replaces
  // the row list; "Load more" (below) appends the next page instead.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    fetch(`/api/reports/audit-export?${queryString('json')}`)
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || 'Could not load audit log')
        if (!cancelled) {
          setRows(json.rows)
          setTotalCount(json.totalCount)
          setTruncated(json.truncated)
          setHasMore(json.hasMore)
        }
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load audit log') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [queryString])

  async function handleLoadMore() {
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/reports/audit-export?${queryString('json', rows.length)}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not load more events')
      setRows(prev => [...prev, ...json.rows])
      setTotalCount(json.totalCount)
      setTruncated(json.truncated)
      setHasMore(json.hasMore)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load more events')
    } finally { setLoadingMore(false) }
  }

  async function handleExport(format: 'csv' | 'pdf') {
    setExporting(format)
    try {
      const res = await fetch(`/api/reports/audit-export?${queryString(format)}`)
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Export failed') }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') || ''
      const match = disposition.match(/filename="([^"]+)"/)
      const filename = match?.[1] || `audit-log.${format}`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally { setExporting(null) }
  }

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">Audit log</h1>
          <p className="page-sub">{totalCount.toLocaleString()} event{totalCount === 1 ? '' : 's'} · immutable record</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" disabled={exporting !== null || loading} onClick={() => handleExport('csv')}>
            {exporting === 'csv' ? <span className="spin" /> : <><i className="ti ti-file-spreadsheet" style={{ marginRight: 6 }} />CSV</>}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={exporting !== null || loading} onClick={() => handleExport('pdf')}>
            {exporting === 'pdf' ? <span className="spin" /> : <><i className="ti ti-file-type-pdf" style={{ marginRight: 6 }} />PDF</>}
          </button>
        </div>
      </div>

      <div className="surface surface-p" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <div className="fgrp" style={{ margin: 0, minWidth: 150 }}>
            <label className="flbl">Date range</label>
            <select className="finp" value={preset} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => applyPreset(e.target.value)}>
              {RANGE_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          {preset === 'custom' && (
            <>
              <div className="fgrp" style={{ margin: 0 }}>
                <label className="flbl">From</label>
                <input type="date" className="finp" value={from} max={to}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFrom(e.target.value)} />
              </div>
              <div className="fgrp" style={{ margin: 0 }}>
                <label className="flbl">To</label>
                <input type="date" className="finp" value={to} min={from} max={isoDate(today)}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)} />
              </div>
            </>
          )}
          <div className="fgrp" style={{ margin: 0, minWidth: 170 }}>
            <label className="flbl">Project</label>
            <select className="finp" value={projectId} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="fgrp" style={{ margin: 0, minWidth: 170 }}>
            <label className="flbl">User</label>
            <select className="finp" value={actorId} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setActorId(e.target.value)}>
              <option value="">All users</option>
              {/* FIX (re-audit, Reports & Audit section): the dropdown used
                  to be built from active members only. Departed members are
                  now included (labeled) so the audit log can actually be
                  filtered by someone who's since left the workspace. */}
              {members.map(m => <option key={m.id} value={m.id}>{m.name}{!m.active ? ' (Former member)' : ''}</option>)}
            </select>
          </div>
          <div className="fgrp" style={{ margin: 0, flex: 1, minWidth: 180 }}>
            <label className="flbl">Search</label>
            <input className="finp search-inp" placeholder="Event or record name…" value={qInput}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQInput(e.target.value)} />
          </div>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}
      {/* FIX (deep audit, Reports & Audit re-pass — feature gap): this used
          to always mean "hit the hard ceiling, go export CSV" because
          there was no other way to see more. Now that "Load more" exists,
          this banner only appears once paging has reached MAX_ROWS_JSON's
          ceiling (api/reports/audit-export/route.ts) — while more pages
          remain below that ceiling, the "Load more" button under the
          table is the way forward instead. */}
      {truncated && !loading && !hasMore && (
        <div className="auth-error" style={{ background: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E', marginBottom: 14 }}>
          Showing the first {rows.length.toLocaleString()} of {totalCount.toLocaleString()} matching events — this view caps out here. Export CSV for the complete record.
        </div>
      )}

      <div className="surface" style={{ overflow: 'hidden' }}>
        <table className="gov-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Event</th>
              <th>Actor</th>
              <th>Entity</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={e.id || i}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: eventColour(e.eventType), flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 12, fontFamily: 'IBM Plex Mono, monospace', color: 'var(--text-2)' }}>{e.eventType}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{e.entityType}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div style={{ fontSize: 13 }}>{e.actorName || 'System'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{e.actorEmail}</div>
                </td>
                <td style={{ fontSize: 13, color: 'var(--text-2)' }}>
                  {e.entityName || '—'}
                  {e.ipAddress && (
                    <div style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'IBM Plex Mono, monospace' }}>{e.ipAddress}</div>
                  )}
                </td>
                <td style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                  {formatRelative(e.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && (
          <div className="empty-state" style={{ padding: '40px 0' }}>
            <span className="spin spin-dark" />
          </div>
        )}
        {!loading && !rows.length && (
          <div className="empty-state" style={{ padding: '40px 0' }}>
            <i className="ti ti-clock empty-state-icon" />
            <p className="empty-state-title">No audit events in this range</p>
          </div>
        )}
        {!loading && hasMore && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 0' }}>
            <button className="btn btn-ghost btn-sm" disabled={loadingMore} onClick={handleLoadMore}>
              {loadingMore ? <span className="spin spin-dark" /> : `Load more (${(totalCount - rows.length).toLocaleString()} remaining)`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
