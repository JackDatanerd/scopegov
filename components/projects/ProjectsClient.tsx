'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { SessionUser } from '@/lib/supabase/types'
import { formatCurrency, formatCurrencyGroups, formatDate, projectStatusLabel, PROJECT_TYPE_ICONS } from '@/lib/utils/format'

type ProjectRow = any // all .from() calls use (supabase as any) per BUG-039

const TABS = [
  { key: 'active',    label: 'Active' },
  { key: 'awaiting',  label: 'Awaiting Signature' },
  { key: 'drafts',    label: 'Drafts' },
  { key: 'completed', label: 'Completed' },
  { key: 'archived',  label: 'Archived' },
  { key: 'all',       label: 'All' },
]

// FIX: Intake, Awaiting Signature, Changes Requested, and Stalled were all
// bucketed under 'active' — meaning a project that hadn't even had its SOW
// sent yet showed under a tab literally called "Active". Stalled
// specifically means "SOW never got signed within 7 days" (see
// /api/cron/sow-stall), not "was active and went stale" — it belongs with
// the other pre-signature states, not with genuinely active/signed
// projects.
const STATUS_TO_TAB: Record<string, string> = {
  'Draft': 'drafts',
  'Intake': 'awaiting',
  'Awaiting Signature': 'awaiting',
  'Changes Requested': 'awaiting',
  'Stalled': 'awaiting',
  'Active': 'active',
  'Complete': 'completed',
  'Archived': 'archived',
}

// Which tab a project lives under. A project the USER paused (stall_reason
// 'manual') is in-flight work and belongs under Active — only a project
// stalled for an unsigned SOW belongs under "Awaiting Signature". Both used to
// land under "Awaiting Signature", so a manually paused Active project seemed
// to vanish from the Active tab.
function tabFor(p: ProjectRow): string {
  if (p.status === 'Stalled') return p.stall_reason === 'manual' ? 'active' : 'awaiting'
  return STATUS_TO_TAB[p.status]
}

const EMPTY_TAB_TEXT: Record<string, string> = {
  active: 'No active projects yet', awaiting: 'No projects awaiting a signature', drafts: 'No draft projects',
  completed: 'No completed projects yet', archived: 'No archived projects', all: 'No projects yet',
}

// New Discussion messages since the viewer last opened the project's Discussion tab.
function UnreadBadge({ count }: { count?: number }) {
  if (!count) return null
  return (
    <span title={`${count} unread discussion message${count === 1 ? '' : 's'}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 600,
        color: 'var(--blue)', background: 'var(--blue-lt, var(--surface-2))', borderRadius: 999, padding: '1px 7px', marginLeft: 6 }}>
      <i className="ti ti-message" style={{ fontSize: 10 }} />{count > 99 ? '99+' : count}
    </span>
  )
}

function pillVariant(status: string): string {
  const m: Record<string, string> = {
    'Active': 'green', 'Awaiting Signature': 'amber', 'Changes Requested': 'amber',
    'Stalled': 'red', 'Complete': 'slate', 'Draft': 'slate', 'Intake': 'blue', 'Archived': 'slate',
  }
  return m[status] || 'slate'
}

interface Props {
  /** Deep link from the dashboard's attention register: /projects?filter=attention */
  initialFilter?: 'attention' | null
  projects: ProjectRow[]
  canCreate: boolean
  canViewFinancials: boolean
  session: SessionUser
}

export default function ProjectsClient({ projects, canCreate, canViewFinancials, initialFilter }: Props) {
  const [tab,    setTab]    = useState(initialFilter === 'attention' ? 'all' : 'active')
  // The dashboard's "Attention register" shows 6 rows; this is where the rest live.
  const [attentionOnly, setAttentionOnly] = useState(initialFilter === 'attention')
  const [search, setSearch] = useState('')
  const [view,   setView]   = useState<'grouped' | 'list'>('grouped')

  const filtered = useMemo(() => {
    let list = projects
    if (tab !== 'all') list = list.filter((p: ProjectRow) => tabFor(p) === tab)
    if (attentionOnly) list = list.filter((p: ProjectRow) => projectAttention(p))
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((p: ProjectRow) =>
        p.name?.toLowerCase().includes(q) ||
        p.clients?.name?.toLowerCase().includes(q) ||
        p.clients?.company_name?.toLowerCase().includes(q) ||
        p.disc?.toLowerCase().includes(q) ||
        // Internal reference (PO / job number) was stored and shown on the
        // project page but not searchable here.
        p.internal_ref?.toLowerCase().includes(q)
      )
    }
    return list
  }, [projects, tab, search, attentionOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  // Attention is decided ON THE SERVER (app/(app)/projects/page.tsx) with the same predicate, inputs and
  // workspace settings as the Dashboard, and arrives as p.needs_attention / p.attention_reason. It used
  // to be re-derived here from the payload — which for a member without VIEW_FINANCIALS has the contract
  // value stripped, so the "high-value project, no signed SOW" rule fired on the Dashboard and not here
  // for the very same project.
  function projectAttention(p: ProjectRow) {
    return !!p.needs_attention
  }

  // Every project the dashboard counts (finished projects never need attention
  // any more, so this now agrees with the dashboard's "Needs attention").
  const attentionCount = useMemo(() =>
    projects.filter((p: ProjectRow) => projectAttention(p)).length
  , [projects]) // eslint-disable-line react-hooks/exhaustive-deps

  const attentionByTab = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of projects) {
      if (!projectAttention(p)) continue
      const t = tabFor(p)
      counts[t] = (counts[t] || 0) + 1
    }
    return counts
  }, [projects])

  const grouped = useMemo(() => {
    const map = new Map<string, { clientName: string; clientId: string; projects: ProjectRow[] }>()
    for (const p of filtered) {
      const cid = p.clients?.id || 'none'
      const cname = p.clients?.name || 'No client'
      if (!map.has(cid)) map.set(cid, { clientName: cname, clientId: cid, projects: [] })
      map.get(cid)!.projects.push(p)
    }
    return Array.from(map.values()).sort((a, b) => a.clientName.localeCompare(b.clientName))
  }, [filtered])

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      {/* Header */}
      <div className="page-hd">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">{projects.length} on record · {attentionCount > 0 ? `${attentionCount} need attention` : 'all clear'}</p>
        </div>
        {canCreate && (
          <Link href="/projects/new">
            <button className="btn btn-primary"><i className="ti ti-plus" style={{ fontSize: 13 }} /> New project</button>
          </Link>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div className="search-wrap" style={{ flex: 1, maxWidth: 280 }}>
          <i className="ti ti-search search-ic" />
          <input className="finp search-inp" placeholder="Search projects…" value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)} />
        </div>
        <button
          className={`btn btn-xs ${attentionOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setAttentionOnly(v => !v)}
          title="Show only projects that need attention">
          <i className="ti ti-alert-triangle" style={{ fontSize: 11, marginRight: 4 }} />
          Needs attention{attentionCount > 0 ? ` (${attentionCount})` : ''}
        </button>
        <div style={{ display: 'flex', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 2 }}>
          <button
            onClick={() => setView('grouped')}
            style={{ padding: '5px 10px', fontSize: 11, borderRadius: 3, border: 'none', cursor: 'pointer',
              background: view === 'grouped' ? 'var(--surface)' : 'transparent',
              color: view === 'grouped' ? 'var(--text)' : 'var(--text-3)',
              boxShadow: view === 'grouped' ? '0 1px 3px rgba(0,0,0,.08)' : 'none' }}>
            <i className="ti ti-layout-list" style={{ fontSize: 12, marginRight: 4 }} />Grouped
          </button>
          <button
            onClick={() => setView('list')}
            style={{ padding: '5px 10px', fontSize: 11, borderRadius: 3, border: 'none', cursor: 'pointer',
              background: view === 'list' ? 'var(--surface)' : 'transparent',
              color: view === 'list' ? 'var(--text)' : 'var(--text-3)',
              boxShadow: view === 'list' ? '0 1px 3px rgba(0,0,0,.08)' : 'none' }}>
            <i className="ti ti-list" style={{ fontSize: 12, marginRight: 4 }} />List
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabbar" style={{ marginBottom: 18 }}>
        {TABS.map(t => (
          <button key={t.key} className={`tabi${tab === t.key ? ' act' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key !== 'all' && attentionByTab[t.key] > 0 && (
              <span className="tabi-badge">{attentionByTab[t.key]}</span>
            )}
            {!attentionByTab[t.key] && (
              <span style={{ marginLeft: 5, fontSize: 11, color: 'var(--text-4)' }}>
                {t.key === 'all' ? projects.length : projects.filter((p: ProjectRow) => tabFor(p) === t.key).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {filtered.length === 0 ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-search empty-state-icon" />
            <p className="empty-state-title">No projects found</p>
            <p className="empty-state-sub">{search ? `No results for "${search}"` : attentionOnly ? 'Nothing needs attention right now.' : (EMPTY_TAB_TEXT[tab] || 'No projects yet')}</p>
          </div>
        </div>
      ) : view === 'grouped' ? (
        <div>
          {grouped.map(group => (
            <ClientGroup key={group.clientId} group={group} canViewFinancials={canViewFinancials} projectAttention={projectAttention} />
          ))}
        </div>
      ) : (
        <div className="surface" style={{ overflow: 'hidden' }}>
          <table className="gov-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Project</th>
                <th>Client</th>
                {canViewFinancials && <th style={{ textAlign: 'right' }}>Value</th>}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p: ProjectRow) => (
                <ProjectTableRow key={p.id} project={p} canViewFinancials={canViewFinancials} hasAttention={projectAttention(p)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ClientGroup({ group, canViewFinancials, projectAttention }: {
  group: { clientName: string; clientId: string; projects: ProjectRow[] }
  canViewFinancials: boolean
  projectAttention: (p: ProjectRow) => boolean
}) {
  const [expanded, setExpanded] = useState(true)
  const attnCount   = group.projects.filter(projectAttention).length
  // FIX (deep audit, section 7): see currencyGroupedTotals in
  // lib/utils/format.ts — this used to sum contract_value across the
  // group regardless of currency, then label the sum with the first
  // project's currency.
  // Effective value (base + accepted change orders; a retainer's monthly rate × term) — the stored base
  // alone ignored every accepted CO.
  const totalValueDisplay = formatCurrencyGroups(
    group.projects.map(p => ({ contract_value: p.effective_value, currency: p.currency })), true)
  const hasValue = group.projects.some(p => (p.effective_value || 0) > 0)

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: 9, padding: '11px 16px',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: expanded ? 'var(--radius) var(--radius) 0 0' : 'var(--radius)',
          cursor: 'pointer', borderBottom: expanded ? 'none' : '1px solid var(--border)',
        }}>
        <i className={`ti ti-chevron-${expanded ? 'down' : 'right'}`} style={{ fontSize: 12, color: 'var(--text-3)' }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{group.clientName}</span>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{group.projects.length} project{group.projects.length !== 1 ? 's' : ''}</span>
        {canViewFinancials && hasValue && (
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>· {totalValueDisplay}</span>
        )}
        {attnCount > 0 && (
          <span className="attn-marker" style={{ marginLeft: 'auto' }}>{attnCount} need attention</span>
        )}
      </div>
      {expanded && (
        <div style={{ border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 var(--radius) var(--radius)', overflow: 'hidden' }}>
          {group.projects.map((p: ProjectRow) => (
            <ProjectGroupRow key={p.id} project={p} canViewFinancials={canViewFinancials} hasAttention={projectAttention(p)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectGroupRow({ project: p, canViewFinancials, hasAttention }: {
  project: ProjectRow; canViewFinancials: boolean; hasAttention: boolean
}) {
  const reason: string | null = hasAttention ? (p.attention_reason || null) : null

  return (
    <Link href={`/projects/${p.id}`}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px',
        borderBottom: '1px solid var(--surface-2)', background: 'var(--surface)',
        cursor: 'pointer', transition: 'background .1s',
      }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--surface)')}>
        <i className={`ti ${PROJECT_TYPE_ICONS[p.type] || 'ti-folder'}`} style={{ fontSize: 13, color: 'var(--text-3)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
            {p.disc && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{p.disc}</span>}
            <UnreadBadge count={p.unread_messages} />
          </div>
          {reason && (
            <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 2 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 10, marginRight: 3 }} />{reason}
            </div>
          )}
        </div>
        {canViewFinancials && p.effective_value > 0 && (
          <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'IBM Plex Mono, monospace', textAlign: 'right' }}>
            {formatCurrency(p.effective_value, p.currency)}
            {p.monthly_rate > 0 && <span style={{ display: 'block', fontSize: 10.5 }}>{formatCurrency(p.monthly_rate, p.currency)}/mo</span>}
          </span>
        )}
        <span className={`pill pill-${pillVariant(p.status)}`}>{projectStatusLabel(p.status)}</span>
        <i className="ti ti-chevron-right" style={{ fontSize: 13, color: 'var(--text-4)' }} />
      </div>
    </Link>
  )
}

function ProjectTableRow({ project: p, canViewFinancials, hasAttention }: {
  project: ProjectRow; canViewFinancials: boolean; hasAttention: boolean
}) {
  // A real link (open in new tab, keyboard, screen readers) plus a full-row
  // click via the client router — the row used to assign window.location,
  // which reloaded the whole app and had no link semantics at all.
  const router = useRouter()
  const reason: string | null = hasAttention ? (p.attention_reason || null) : null
  return (
    <tr style={{ cursor: 'pointer' }} onClick={() => router.push(`/projects/${p.id}`)}>
      <td>
        <Link href={`/projects/${p.id}`} onClick={e => e.stopPropagation()} style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="td-primary">{p.name} <UnreadBadge count={p.unread_messages} /></div>
        </Link>
        {p.disc && <div className="td-sub">{p.disc}</div>}
      </td>
      <td style={{ color: 'var(--text-2)', fontSize: 13 }}>
        {p.clients?.name || '—'}
        {hasAttention && <span className="attn-marker" style={{ marginLeft: 8 }}>{reason || 'Attention'}</span>}
      </td>
      {canViewFinancials && (
        <td className="td-mono" style={{ textAlign: 'right' }}>
          {p.effective_value ? formatCurrency(p.effective_value, p.currency) : '—'}
          {p.monthly_rate > 0 && <div className="td-sub">{formatCurrency(p.monthly_rate, p.currency)}/mo</div>}
        </td>
      )}
      <td><span className={`pill pill-${pillVariant(p.status)}`}>{projectStatusLabel(p.status)}</span></td>
    </tr>
  )
}
