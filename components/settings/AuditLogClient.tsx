'use client'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import Link from 'next/link'
import { formatRelative } from '@/lib/utils/format'
import { AUDIT_CATEGORIES } from '@/lib/audit/categories'

interface Project { id: string; name: string; deleted?: boolean }
interface Member { id: string; name: string; email: string; active: boolean }
interface Row {
  id: string
  eventType: string
  entityType: string
  entityId: string | null
  entityName: string | null
  actorId: string | null
  actorName: string | null
  actorEmail: string
  projectId: string | null
  createdAt: string
  ipAddress: string | null
  metadata: Record<string, unknown> | null
}

function eventColour(type: string) {
  if (type.includes('signed') || type.includes('accepted') || type.includes('completed') || type.includes('joined') || type.includes('enabled')) return 'var(--green)'
  if (type.includes('declined') || type.includes('failed') || type.includes('stalled') || type.includes('deleted') || type.includes('disabled')) return 'var(--red)'
  if (type.includes('flag') || type.includes('guardian') || type.includes('escalated')) return 'var(--amber)'
  if (type.includes('billing') || type.includes('plan')) return 'var(--blue)'
  return 'var(--text-3)'
}

// FIX (Reports & Audit re-pass #3): dates used to be built with
// toISOString().slice(0, 10) — the UTC calendar day — and sent to the server
// as bare dates (also read as UTC). For anyone east of UTC (Nairobi is +3)
// "today" was wrong for the first hours of every local day and the picker's
// `max` blocked choosing it. Dates are now the viewer's LOCAL calendar days,
// and the request carries the exact instants those days start and end at.
function localDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function startOfLocalDay(ymd: string): Date | null {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, 0, 0, 0, 0)
}
function endOfLocalDay(ymd: string): Date | null {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, 23, 59, 59, 999)
}
function daysAgoLocal(days: number) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return localDate(d)
}

const RANGE_PRESETS = [
  { key: '30d',  label: 'Last 30 days',  days: 30 },
  { key: '90d',  label: 'Last 90 days',  days: 90 },
  { key: '12m',  label: 'Last 12 months', days: 365 },
  { key: 'custom', label: 'Custom range', days: 0 },
]

// Debounce for the free-text search. Export bypasses it (uses the live input)
// so clicking Export right after typing can never export the previous filter.
const SEARCH_DEBOUNCE_MS = 350

function formatExact(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

function formatMetaValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return String(v) }
}

export default function AuditLogClient({ projects, members }: { projects: Project[]; members: Member[] }) {
  const [preset, setPreset] = useState('90d')
  const [from, setFrom] = useState(daysAgoLocal(90))
  const [to, setTo] = useState(localDate(new Date()))
  const [projectId, setProjectId] = useState('')
  const [actorId, setActorId] = useState('')
  const [category, setCategory] = useState('')
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
  const [asOf, setAsOf] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  // Monotonic id of the current filter set. Anything that resolves after the
  // filters changed (a slow first page, or a "Load more" started under the
  // old filters) compares against it and is dropped — previously a late
  // "Load more" response was appended onto the NEW filter's rows.
  const querySeq = useRef(0)

  const projectsById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects])

  function applyPreset(key: string) {
    setPreset(key)
    const p = RANGE_PRESETS.find(r => r.key === key)
    if (p && p.days > 0) {
      setFrom(daysAgoLocal(p.days))
      setTo(localDate(new Date()))
    }
  }

  const dateError = useMemo(() => {
    const f = startOfLocalDay(from), t = endOfLocalDay(to)
    if (!f || !t) return 'Choose both a start and an end date.'
    if (f.getTime() > t.getTime()) return 'The start date must be on or before the end date.'
    return ''
  }, [from, to])

  const buildParams = useCallback((format: string, opts: { q: string; offset?: number; asOf?: string | null }) => {
    const params = new URLSearchParams({ format })
    const f = startOfLocalDay(from), t = endOfLocalDay(to)
    if (f) params.set('from', f.toISOString())
    if (t) params.set('to', t.toISOString())
    if (projectId) params.set('projectId', projectId)
    if (actorId) params.set('actorId', actorId)
    if (category) params.set('category', category)
    if (opts.q.trim()) params.set('q', opts.q.trim())
    if (opts.offset) params.set('offset', String(opts.offset))
    if (opts.asOf) params.set('asOf', opts.asOf)
    return params.toString()
  }, [from, to, projectId, actorId, category])

  // Any filter change starts over: cancel the in-flight request, clear the
  // old rows immediately (stale rows must never sit under a new filter or an
  // error banner), and reload page one.
  useEffect(() => {
    const seq = ++querySeq.current
    setRows([]); setExpanded(null); setHasMore(false); setTruncated(false); setAsOf(null)
    if (dateError) { setLoading(false); setError(dateError); setTotalCount(0); return }
    const ctrl = new AbortController()
    setLoading(true); setError('')
    fetch(`/api/reports/audit-export?${buildParams('json', { q })}`, { signal: ctrl.signal })
      .then(async res => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error || 'Could not load audit log')
        if (seq !== querySeq.current) return
        setRows(json.rows)
        setTotalCount(json.totalCount)
        setTruncated(json.truncated)
        setHasMore(json.hasMore)
        setAsOf(json.asOf || null)
      })
      .catch((err: unknown) => {
        if ((err as any)?.name === 'AbortError' || seq !== querySeq.current) return
        setTotalCount(0)
        setError(err instanceof Error ? err.message : 'Could not load audit log')
      })
      .finally(() => { if (seq === querySeq.current) setLoading(false) })
    return () => { ctrl.abort() }
  }, [buildParams, q, dateError])

  async function handleLoadMore() {
    const seq = querySeq.current
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/reports/audit-export?${buildParams('json', { q, offset: rows.length, asOf })}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not load more events')
      if (seq !== querySeq.current) return // filters changed while this was in flight
      // De-dupe by id as a belt-and-braces guard on top of the server's
      // pinned snapshot + deterministic ordering.
      setRows(prev => {
        const seen = new Set(prev.map(r => r.id))
        return [...prev, ...json.rows.filter((r: Row) => !seen.has(r.id))]
      })
      setTotalCount(json.totalCount)
      setTruncated(json.truncated)
      setHasMore(json.hasMore)
    } catch (err: unknown) {
      if (seq === querySeq.current) setError(err instanceof Error ? err.message : 'Could not load more events')
    } finally { setLoadingMore(false) }
  }

  async function handleExport(format: 'csv' | 'pdf') {
    if (dateError) return
    setExporting(format)
    try {
      // Uses the live input, not the debounced value.
      const res = await fetch(`/api/reports/audit-export?${buildParams(format, { q: qInput })}`)
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

  const todayStr = localDate(new Date())

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-hd">
        <div>
          <div style={{ marginBottom: 6 }}>
            <Link href="/settings" style={{ fontSize: 12, color: 'var(--text-3)' }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Settings
            </Link>
          </div>
          <h1 className="page-title">Audit log</h1>
          <p className="page-sub">{totalCount.toLocaleString()} event{totalCount === 1 ? '' : 's'} · immutable record</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" disabled={exporting !== null || loading || !!dateError} onClick={() => handleExport('csv')}>
            {exporting === 'csv' ? <span className="spin" /> : <><i className="ti ti-file-spreadsheet" style={{ marginRight: 6 }} />CSV</>}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={exporting !== null || loading || !!dateError} onClick={() => handleExport('pdf')}>
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
                <input type="date" className="finp" value={from} max={to || todayStr}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFrom(e.target.value)} />
              </div>
              <div className="fgrp" style={{ margin: 0 }}>
                <label className="flbl">To</label>
                <input type="date" className="finp" value={to} min={from} max={todayStr}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)} />
              </div>
            </>
          )}
          <div className="fgrp" style={{ margin: 0, minWidth: 170 }}>
            <label className="flbl">Project</label>
            <select className="finp" value={projectId} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.deleted ? ' (deleted)' : ''}</option>)}
            </select>
          </div>
          <div className="fgrp" style={{ margin: 0, minWidth: 170 }}>
            <label className="flbl">User</label>
            <select className="finp" value={actorId} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setActorId(e.target.value)}>
              <option value="">All users</option>
              <option value="none">System / client portal (no user)</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.name}{!m.active ? ' (Former member)' : ''}</option>)}
            </select>
          </div>
          <div className="fgrp" style={{ margin: 0, minWidth: 170 }}>
            <label className="flbl">Type</label>
            <select className="finp" value={category} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCategory(e.target.value)}>
              <option value="">All events</option>
              {AUDIT_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div className="fgrp" style={{ margin: 0, flex: 1, minWidth: 200 }}>
            <label className="flbl">Search</label>
            <input className="finp search-inp" placeholder="Event, record, person or IP…" value={qInput} maxLength={100}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQInput(e.target.value)} />
          </div>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}
      {truncated && !loading && !hasMore && (
        <div className="auth-error" style={{ background: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E', marginBottom: 14 }}>
          Showing the first {rows.length.toLocaleString()} of {totalCount.toLocaleString()} matching events — this view caps out here. Export CSV (up to 25,000 rows) or narrow the filters for the rest.
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
            {rows.map(e => {
              const open = expanded === e.id
              const project = e.projectId ? projectsById.get(e.projectId) : undefined
              const metaEntries = e.metadata ? Object.entries(e.metadata) : []
              return (
                <RowFragment key={e.id}>
                  <tr onClick={() => setExpanded(open ? null : e.id)} style={{ cursor: 'pointer' }} aria-expanded={open}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <i className={`ti ti-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: 12, color: 'var(--text-4)' }} />
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
                    <td style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }} title={e.createdAt}>
                      <div>{formatExact(e.createdAt)}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-4)' }}>{formatRelative(e.createdAt)}</div>
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={4} style={{ background: 'var(--surface-2, rgba(0,0,0,0.02))', padding: '12px 16px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 4, fontSize: 12 }}>
                          <span style={{ color: 'var(--text-3)' }}>Exact time</span>
                          <span>{formatExact(e.createdAt)} · <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{e.createdAt}</span></span>
                          <span style={{ color: 'var(--text-3)' }}>Record</span>
                          <span>{e.entityType}{e.entityName ? ` · ${e.entityName}` : ''}{e.entityId ? <span style={{ fontFamily: 'IBM Plex Mono, monospace', color: 'var(--text-3)' }}> · {e.entityId}</span> : null}</span>
                          {e.projectId && (
                            <>
                              <span style={{ color: 'var(--text-3)' }}>Project</span>
                              <span>{project && !project.deleted ? <a href={`/projects/${e.projectId}`}>{project.name}</a> : `${project?.name || 'Deleted project'}${project?.deleted ? ' (deleted)' : ''}`}</span>
                            </>
                          )}
                          <span style={{ color: 'var(--text-3)' }}>Actor</span>
                          <span>{e.actorName || 'System'} · {e.actorEmail}{e.actorId ? <span style={{ fontFamily: 'IBM Plex Mono, monospace', color: 'var(--text-3)' }}> · {e.actorId}</span> : ' · no signed-in user'}</span>
                          <span style={{ color: 'var(--text-3)' }}>IP address</span>
                          <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{e.ipAddress || 'not recorded'}</span>
                          {metaEntries.length > 0 && (
                            <>
                              <span style={{ color: 'var(--text-3)' }}>Details</span>
                              <span>
                                {metaEntries.map(([k, v]) => (
                                  <div key={k}><span style={{ color: 'var(--text-3)' }}>{k}:</span> <span style={{ fontFamily: 'IBM Plex Mono, monospace', wordBreak: 'break-word' }}>{formatMetaValue(v)}</span></div>
                                ))}
                              </span>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </RowFragment>
              )
            })}
          </tbody>
        </table>
        {loading && (
          <div className="empty-state" style={{ padding: '40px 0' }}>
            <span className="spin spin-dark" />
          </div>
        )}
        {!loading && !error && !rows.length && (
          <div className="empty-state" style={{ padding: '40px 0' }}>
            <i className="ti ti-clock empty-state-icon" />
            <p className="empty-state-title">No audit events match these filters</p>
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

// A keyed fragment so a row and its detail row stay siblings inside <tbody>.
function RowFragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
