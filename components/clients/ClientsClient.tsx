'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatCurrency, formatDate } from '@/lib/utils/format'

export default function ClientsClient({ clients, canCreate, canViewFinancials, canViewClientData }: {
  clients: any[]; canCreate: boolean; canViewFinancials: boolean; canViewClientData: boolean
}) {
  const router  = useRouter()
  const [search,  setSearch]  = useState('')
  const [modal,   setModal]   = useState(false)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
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

  const filtered = useMemo(() => {
    const base = showArchived ? clients : clients.filter(c => c.status !== 'archived')
    if (!search.trim()) return base
    const q = search.toLowerCase()
    return base.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q) ||
      c.company_name?.toLowerCase().includes(q)
    )
  }, [clients, search, showArchived])

  function clientStats(c: any) {
    const projects  = c.projects || []
    const active    = projects.filter((p: any) => ['Active','Awaiting Signature','Intake','Changes Requested'].includes(p.status)).length
    const total     = projects.length
    const value     = projects.reduce((s: number, p: any) => s + (p.contract_value || 0), 0)
    const currency  = projects[0]?.currency || 'USD'
    return { active, total, value, currency }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !email.trim()) return
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/clients', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, companyName: company, email, phone, ccEmails }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setModal(false)
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
          <p className="page-sub">{clients.length} client{clients.length !== 1 ? 's' : ''} on record</p>
        </div>
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setModal(true)}>
            <i className="ti ti-plus" style={{ fontSize: 13 }} /> New client
          </button>
        )}
      </div>

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
                <th>Client</th>
                <th>Contact</th>
                <th style={{ textAlign: 'center' }}>Projects</th>
                {canViewFinancials && <th style={{ textAlign: 'right' }}>Total value</th>}
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const stats = clientStats(c)
                return (
                  <tr key={c.id} onClick={() => router.push(`/clients/${c.id}`)}>
                    <td>
                      <div className="td-primary">
                        {c.name}
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
                        {stats.value > 0 ? formatCurrency(stats.value, stats.currency) : '—'}
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
            {error && <div className="auth-error">{error}</div>}
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
