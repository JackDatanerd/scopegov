'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'

interface SearchResult {
  type:  string
  id:    string
  title: string
  sub:   string
  href:  string
}

const TYPE_ICONS: Record<string, string> = {
  project:       'ti-folder',
  client:        'ti-user',
  change_order:  'ti-git-merge',
  sow:           'ti-file-text',
}

interface Props {
  // FIX (audit): Portfolio is permission-gated on the sidebar (VIEW_ALL_PROJECTS)
  // but the palette had no way to know a user's permissions at all — passed
  // down from the layout so the quick-nav list can match the sidebar exactly.
  permissions?: string[]
}

export default function CommandPalette({ permissions = [] }: Props) {
  const router        = useRouter()
  const [open,    setOpen]    = useState(false)
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [idx,     setIdx]     = useState(0)
  const inputRef  = useRef<HTMLInputElement>(null)
  const debounce  = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const search = useCallback((q: string) => {
    if (debounce.current) clearTimeout(debounce.current)
    if (!q.trim() || q.length < 2) { setResults([]); return }
    debounce.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
        const json = await res.json()
        setResults(json.results || [])
        setIdx(0)
      } finally { setLoading(false) }
    }, 200)
  }, [])

  useEffect(() => { search(query) }, [query, search])

  function navigate(href: string) {
    setOpen(false)
    setQuery('')
    router.push(href)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown')  { e.preventDefault(); setIdx(i => Math.min(i + 1, results.length - 1)) }
    if (e.key === 'ArrowUp')    { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && results[idx]) navigate(results[idx].href)
  }

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(26,26,26,.45)', backdropFilter: 'blur(3px)' }}
      />

      {/* Palette */}
      <div style={{
        position: 'fixed', left: '50%', top: '18%', transform: 'translateX(-50%)',
        zIndex: 1001, width: '100%', maxWidth: 580,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: 'var(--shadow-md)', overflow: 'hidden',
      }}>
        {/* Input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <i className="ti ti-search" style={{ fontSize: 16, color: 'var(--text-3)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search projects, clients, change orders…"
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 14, background: 'transparent', color: 'var(--text)' }}
          />
          {loading && <span className="spin spin-dark" style={{ width: 14, height: 14 }} />}
          <kbd style={{ fontSize: 10, color: 'var(--text-3)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px' }}>
            ESC
          </kbd>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {results.map((r, i) => (
              <button
                key={r.id}
                onClick={() => navigate(r.href)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  width: '100%', padding: '11px 16px', border: 'none',
                  background: i === idx ? 'var(--green-lt)' : 'transparent',
                  cursor: 'pointer', textAlign: 'left',
                  borderBottom: '1px solid var(--surface-2)',
                  transition: 'background .1s',
                }}
                onMouseEnter={() => setIdx(i)}
              >
                <div style={{
                  width: 30, height: 30, borderRadius: 6, flexShrink: 0,
                  background: i === idx ? 'var(--green)' : 'var(--surface-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <i className={`ti ${TYPE_ICONS[r.type] || 'ti-file'}`}
                    style={{ fontSize: 14, color: i === idx ? '#FFF' : 'var(--text-3)' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: i === idx ? 'var(--green)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.sub}
                  </div>
                </div>
                <i className="ti ti-arrow-right" style={{ fontSize: 12, color: i === idx ? 'var(--green)' : 'var(--text-4)', flexShrink: 0 }} />
              </button>
            ))}
          </div>
        )}

        {query.length >= 2 && !loading && results.length === 0 && (
          <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>
            No results for &ldquo;{query}&rdquo;
          </div>
        )}

        {!query && (
          <div style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600 }}>
              Quick navigation
            </div>
            {[
              { label: 'Dashboard',   href: '/dashboard',   icon: 'ti-layout-dashboard' },
              { label: 'Projects',    href: '/projects',    icon: 'ti-folder' },
              { label: 'Clients',     href: '/clients',     icon: 'ti-users' },
              { label: 'SOW Registry', href: '/sow',        icon: 'ti-file-description' },
              // FIX (audit): Invoices, Approvals, Team, and Portfolio are all
              // primary sidebar destinations that had no quick-nav entry here.
              { label: 'Invoices',    href: '/invoices',    icon: 'ti-receipt-2' },
              { label: 'Approvals',   href: '/approvals',   icon: 'ti-shield-check' },
              { label: 'Reports',     href: '/reports',     icon: 'ti-chart-bar' },
              ...(permissions.includes('VIEW_ALL_PROJECTS')
                ? [{ label: 'Portfolio', href: '/portfolio', icon: 'ti-building-skyscraper' }]
                : []),
              { label: 'Team',        href: '/team',        icon: 'ti-user-circle' },
              { label: 'Settings',    href: '/settings',    icon: 'ti-settings' },
            ].map(item => (
              <button key={item.href} onClick={() => navigate(item.href)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', border: 'none', background: 'none', cursor: 'pointer', borderRadius: 6, fontSize: 13, color: 'var(--text-2)', textAlign: 'left' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                <i className={`ti ${item.icon}`} style={{ fontSize: 14, color: 'var(--text-3)', width: 20 }} />
                {item.label}
              </button>
            ))}
          </div>
        )}

        {/* Footer hint */}
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-4)' }}>
          <span><kbd style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 4px' }}>↑↓</kbd> navigate</span>
          <span><kbd style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 4px' }}>↵</kbd> open</span>
          <span><kbd style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 4px' }}>⌘K</kbd> toggle</span>
        </div>
      </div>
    </>
  )
}
