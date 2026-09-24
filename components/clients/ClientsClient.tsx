'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatCurrencyGroups, formatDate } from '@/lib/utils/format'
import { IN_PROGRESS_STATUSES } from '@/lib/utils/project-status'

type SortKey = 'name' | 'projects' | 'since'

// CSV cells that start with = + - @ are executed as formulas by Excel / Sheets — neutralise them.
function csvCell(v: unknown): string {
  let t = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`
  return `"${t.replace(/"/g, '""')}"`
}

export default function ClientsClient({ clients, canCreate, canViewFinancials, canViewClientData, truncated = false }: {
  clients: any[]; canCreate: boolean; canViewFinancials: boolean; canViewClientData: boolean; truncated?: boolean
}) {
  const router  = useRouter()
  const [search,  setSearch]  = useState('')
  const [modal,   setModal]   = useState(false)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  // A 409 from the API carries the existing client — offer to open it instead of a dead-end error.
  const [existing, setExisting] = useState<{ id: string; name: string } | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [name,    setName]    = useState('')
  const [company, setCompany] = useState('')
  const [email,   setEmail]   = useState('')
  const [phone,   setPhone]   = useState('')
  const [ccEmails, setCcEmails] = useState('')
  // FIX (audit round 6): clients.status (active/archived) has existed
  // since the initial schema and was even selected by the page query, but
  // nothing ever read or filtered by it — every client showed up mixed
  // together forever with no way to hide the ones an agency no longer
  // works with. Default to hiding archived ones, same as most list views.
  const [showArchived, setShowArchived] = useState(false)

  const archivedCount = useMemo(() => clients.filter(c => c.status === 'archived').length, [clients])

  // FIX (independent pass, section 14): phone wasn't searchable although it's shown in the table, and
  // when a search only matched ARCHIVED clients (hidden by default) the empty state said "No results"
  // with no hint that they existed.
  const matches = (c: any, q: string) =>
    c.name.toLowerCase().includes(q) ||
    c.email?.toLowerCase().includes(q) ||
    c.phone?.toLowerCase().includes(q) ||
    c.company_name?.toLowerCase().includes(q)

  const hiddenArchivedMatches = useMemo(() => {
    if (showArchived || !search.trim()) return 0
    const q = search.trim().toLowerCase()
    return clients.filter(c => c.status === 'archived' && matches(c, q)).length
  }, [clients, search, showArchived])

  const filtered = useMemo(() => {
    const base = showArchived ? clients : clients.filter(c => c.status !== 'archived')
    const q = search.trim().toLowerCase()
    const rows = q ? base.filter(c => matches(c, q)) : base
    const dir = sortDir === 'asc' ? 1 : -1
    const key = (c: any) => sortKey === 'name' ? String(c.name || '').toLowerCase()
      : sortKey === 'projects' ? (c.projects || []).length
      : String(c.created_at || '')
    return [...rows].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0) * dir)
  }, [clients, search, showArchived, sortKey, sortDir])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc') }
  }
  const sortMark = (k: SortKey) => sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  function exportCsv() {
    const header = ['Name', 'Company', ...(canViewClientData ? ['Email', 'Phone'] : []), 'Status', 'Projects', 'Active projects', 'Client since']
    const lines = [header.map(csvCell).join(',')]
    for (const c of filtered) {
      const st = clientStats(c)
      lines.push([
        c.name, c.company_name || '', ...(canViewClientData ? [c.email || '', c.phone || ''] : []),
        c.status || 'active', st.total, st.active, String(c.created_at || '').slice(0, 10),
      ].map(csvCell).join(','))
    }
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  // FIX (deep audit, section 14, finding #5): this list disagreed with
  // clients/[id]/page.tsx's ACTIVE_STATUSES (used for the archive-warning
  // threshold) on whether 'Stalled' counts as active — a client with only
  // a Stalled project showed "0 active" here but would count toward the
  // warning on its own detail page. Same list, both places.
  const ACTIVE_STATUSES: readonly string[] = IN_PROGRESS_STATUSES // one shared definition (was a local copy)
  // FIX (deep audit, section 14 — flagship finding): value used to be a
  // plain reduce() summing contract_value across every one of a client's
  // projects regardless of currency, labelled with whichever project
  // happened to be first in the array — the exact same bug class already
  // fixed in dashboard/page.tsx and ProjectsClient.tsx (see
  // currencyGroupedTotals in lib/utils/format.ts), just never applied
  // here. A client with e.g. one USD and one KES project got a single
  // "total value" that silently added the two currencies together under
  // one wrong currency label. valueDisplay now groups by currency instead
  // of picking one.
  function clientStats(c: any) {
    const projects  = c.projects || []
    const active    = projects.filter((p: any) => ACTIVE_STATUSES.includes(p.status)).length
    const total     = projects.length
    const hasValue  = projects.some((p: any) => (p.contract_value || 0) > 0)
    const valueDisplay = formatCurrencyGroups(projects)
    return { active, total, hasValue, valueDisplay }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !email.trim()) return
    setLoading(true); setError(''); setExisting(null)
    try {
      const res  = await fetch('/api/clients', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, companyName: company, email, phone, ccEmails }),
      })
      const json = await res.json()
      if (!res.ok) {
        if (res.status === 409 && json.existingClientId) setExisting({ id: json.existingClientId, name: json.existingClientName || 'the existing client' })
        throw new Error(json.error)
      }
      setModal(false)
      setExisting(null)
      setName(''); setCompany(''); setEmail(''); setPhone(''); setCcEmails('')
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create client')
    } finally { setLoading(false) }
  }

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      {/* Header */}
      <div className="page-hd">
        <div>
          <h1 className="page-title">Clients</h1>
          <p className="page-sub">
            {clients.length - archivedCount} active client{clients.length - archivedCount !== 1 ? 's' : ''}
            {archivedCount > 0 ? ` · ${archivedCount} archived` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {filtered.length > 0 && (
            <button className="btn btn-ghost" onClick={exportCsv} title="Download the clients shown as a CSV file">
              <i className="ti ti-download" style={{ fontSize: 13 }} /> Export CSV
            </button>
          )}
          {canCreate && (
            <button className="btn btn-primary" onClick={() => setModal(true)}>
              <i className="ti ti-plus" style={{ fontSize: 13 }} /> New client
            </button>
          )}
        </div>
      </div>

      {truncated && (
        <div className="auth-error" style={{ marginBottom: 12 }}>
          This workspace has more clients than can be listed here — only the first {clients.length.toLocaleString()} (A–Z) are shown. Use search from the top bar to find the rest.
        </div>
      )}

      {/* Search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="search-wrap" style={{ maxWidth: 280 }}>
          <i className="ti ti-search search-ic" />
          <input className="finp search-inp" placeholder="Search clients…" value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)} />
        </div>
        {archivedCount > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            Show archived ({archivedCount})
          </label>
        )}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-users empty-state-icon" />
            <p className="empty-state-title">{search ? `No results for "${search}"` : 'No clients yet'}</p>
            {hiddenArchivedMatches > 0 && (
              <p className="empty-state-sub">
                {hiddenArchivedMatches} archived client{hiddenArchivedMatches !== 1 ? 's match' : ' matches'} —{' '}
                <button className="btn btn-ghost btn-xs" onClick={() => setShowArchived(true)}>show archived</button>
              </p>
            )}
            <p className="empty-state-sub">Clients are created automatically when you create a project, or you can add them here.</p>
            {canCreate && !search && (
              <button className="btn btn-primary" onClick={() => setModal(true)}>
                <i className="ti ti-plus" style={{ fontSize: 13 }} /> New client
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="surface" style={{ overflow: 'hidden' }}>
          <table className="gov-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('name')}>Client{sortMark('name')}</th>
                <th>Contact</th>
                <th style={{ textAlign: 'center', cursor: 'pointer' }} onClick={() => toggleSort('projects')}>Projects{sortMark('projects')}</th>
                {canViewFinancials && <th style={{ textAlign: 'right' }}>Total value</th>}
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('since')}>Since{sortMark('since')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const stats = clientStats(c)
                return (
                  <tr key={c.id} style={{ cursor: 'pointer' }} onClick={(e) => {
                    // A real link inside handles its own navigation (incl. open-in-new-tab); the row is a convenience.
                    if ((e.target as HTMLElement).closest('a') || e.metaKey || e.ctrlKey || e.shiftKey) return
                    router.push(`/clients/${c.id}`)
                  }}>
                    <td>
                      <div className="td-primary">
                        <Link href={`/clients/${c.id}`} style={{ color: 'inherit' }}>{c.name}</Link>
                        {c.email_bounced_at && (
                          <span className="pill pill-red pill-sm" style={{ marginLeft: 8 }} title="Email to this client recently bounced — check the address">bounced</span>
                        )}
                        {c.status === 'archived' && (
                          <span style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-3)', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Archived</span>
                        )}
                      </div>
                      {c.company_name && <div className="td-sub">{c.company_name}</div>}
                    </td>
                    <td>
                      {canViewClientData ? (
                        <>
                          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{c.email}</div>
                          {c.phone && <div className="td-sub">{c.phone}</div>}
                        </>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>Restricted</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 18 }}>{stats.total}</div>
                      {stats.active > 0 && <div className="td-sub">{stats.active} active</div>}
                    </td>
                    {canViewFinancials && (
                      <td className="td-mono" style={{ textAlign: 'right' }}>
                        {stats.hasValue ? stats.valueDisplay : '—'}
                      </td>
                    )}
                    <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatDate(c.created_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      {modal && (
        <>
          <div className="modal-bg" onClick={() => setModal(false)} />
          <div className="modal">
            <h2 className="modal-title">New client</h2>
            <p className="modal-sub">Add a client to your workspace. You can also create clients during project creation.</p>
            {error && (
              <div className="auth-error">
                {error}
                {existing && <> — <Link href={`/clients/${existing.id}`} style={{ textDecoration: 'underline' }}>open {existing.name}</Link></>}
              </div>
            )}
            <form onSubmit={handleCreate}>
              <div className="f2">
                <div className="fgrp">
                  <label className="flbl">Client name</label>
                  <input className="finp" value={name} autoFocus required
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                    placeholder="Jane Mwangi" />
                </div>
                <div className="fgrp">
                  <label className="flbl">Company <span className="fhint">— optional</span></label>
                  <input className="finp" value={company}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCompany(e.target.value)}
                    placeholder="Acme Corp" />
                </div>
              </div>
              <div className="f2">
                <div className="fgrp">
                  <label className="flbl">Email</label>
                  <input type="email" className="finp" value={email} required
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                    placeholder="jane@acme.com" />
                </div>
                <div className="fgrp">
                  <label className="flbl">Phone <span className="fhint">— optional</span></label>
                  <input className="finp" value={phone}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPhone(e.target.value)}
                    placeholder="+254 7xx xxx xxx" />
                </div>
              </div>
              <div className="fgrp">
                <label className="flbl">CC on emails <span className="fhint">— optional, comma-separated</span></label>
                <input className="finp" value={ccEmails}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCcEmails(e.target.value)}
                  placeholder="finance@acme.com, legal@acme.com" />
                <p className="fhint" style={{ marginTop: 4 }}>These addresses are CC&apos;d on every invoice, SOW, and change order sent to this client.</p>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={loading || !name.trim() || !email.trim()}>
                  {loading ? <span className="spin" /> : 'Create client'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  )
}
