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
  // FIX (build, search section): invoice results now come back from
  // /api/search (see that route) — needed an icon to match.
  invoice:       'ti-receipt-2',
  // FIX (deep audit, search section — feature gap): guardian flags are
  // now searchable too — see that route's fix comment.
  guardian_flag: 'ti-shield-bolt',
  contact:       'ti-address-book',
}

// Group headings shown when the result type changes (results arrive already grouped by type).
const TYPE_LABELS: Record<string, string> = {
  project: 'Projects', client: 'Clients', contact: 'Client contacts', change_order: 'Change orders',
  sow: 'Statements of work', invoice: 'Invoices', guardian_flag: 'Scope flags',
}

interface Props {
  // FIX (audit): Portfolio is permission-gated on the sidebar (VIEW_PORTFOLIO)
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
  // 'error' and 'partial' exist because the palette used to render every failure — an expired session, a
  // 500, the route's own "Search failed" 200 — as "No results", and a network error was an unhandled rejection.
  const [status,  setStatus]  = useState<'idle' | 'ok' | 'error' | 'rate'>('idle')
  const [partial, setPartial] = useState(false)
  const [idx,     setIdx]     = useState(0)
  const inputRef  = useRef<HTMLInputElement>(null)
  const debounce  = useRef<ReturnType<typeof setTimeout> | null>(null)
  // FIX (re-audit, search section): no request-cancellation or staleness
  // guard existed — search() unconditionally did setResults(json.results)
  // on every response. If the user paused twice mid-typing (two separate
  // debounce windows, each a real request) and those two responses
  // resolved out of order — plausible on any real network — the results
  // shown could silently belong to an earlier, already-abandoned query.
  // A monotonic sequence ref, bumped per request and checked on resolve,
  // fixes it without needing AbortController plumbing through fetch.
  const seq = useRef(0)

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
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
      setStatus('idle'); setPartial(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const search = useCallback((q: string) => {
    if (debounce.current) clearTimeout(debounce.current)
    // FIX (Notifications & email / Search fix round): every call now invalidates whatever request is in
    // flight, INCLUDING the ones that don't start a new one. Clearing the box (or backspacing to one
    // character) only cleared the results and the timer; a request already on the wire still matched
    // `seq.current` when it returned and repopulated the list under an empty or one-letter query, next to
    // the Quick navigation panel.
    const mySeq = ++seq.current
    if (!q.trim() || q.trim().length < 2) {
      setResults([]); setLoading(false); setStatus('idle'); setPartial(false)
      return
    }
    debounce.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
        if (mySeq !== seq.current) return // a newer query has since started — drop this stale response
        if (res.status === 429) { setResults([]); setStatus('rate'); return }
        const json = await res.json().catch(() => null)
        if (mySeq !== seq.current) return
        if (!res.ok || !json) { setResults([]); setStatus('error'); return }
        setResults(json.results || [])
        setPartial(!!json.partial)
        setStatus('ok')
        setIdx(0)
      } catch {
        if (mySeq === seq.current) { setResults([]); setStatus('error') }
      } finally {
        if (mySeq === seq.current) setLoading(false)
      }
    }, 200)
  }, [])

  useEffect(() => { search(query) }, [query, search])

  function navigate(href: string) {
    setOpen(false)
    setQuery('')
    router.push(href)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Enter while an IME composition is open (Japanese/Chinese/Korean candidate selection) confirms the
    // candidate — it must not also navigate.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown')  { e.preventDefault(); setIdx(i => Math.min(i + 1, results.length - 1)) }
    if (e.key === 'ArrowUp')    { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && results[idx]) navigate(results[idx].href)
  }

  // The list scrolls inside a 360px box but the selection only moved a highlight, so with more than
  // ~7 results the selected row disappeared below the fold while arrowing down.
  useEffect(() => {
    document.getElementById(`cmdk-opt-${idx}`)?.scrollIntoView({ block: 'nearest' })
  }, [idx, results])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(26,26,26,.45)', backdropFilter: 'blur(3px)' }}
      />

      {/* Palette */}
      <div role="dialog" aria-modal="true" aria-label="Search" style={{
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
            role="combobox" aria-expanded={results.length > 0} aria-controls="cmdk-list" aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? `cmdk-opt-${idx}` : undefined}
            placeholder="Search projects, clients, contacts, SOWs, change orders, invoices, flags…"
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 14, background: 'transparent', color: 'var(--text)' }}
          />
          {loading && <span className="spin spin-dark" style={{ width: 14, height: 14 }} />}
          <kbd style={{ fontSize: 10, color: 'var(--text-3)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px' }}>
            ESC
          </kbd>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div id="cmdk-list" role="listbox" aria-label="Search results" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {results.map((r, i) => (
              <div key={r.id}>
                {(i === 0 || results[i - 1].type !== r.type) && (
                  <div role="presentation" style={{ padding: '8px 16px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-4)', background: 'var(--surface)' }}>
                    {TYPE_LABELS[r.type] || r.type}
                  </div>
                )}
                <button
                  id={`cmdk-opt-${i}`}
                  role="option" aria-selected={i === idx}
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
              </div>
            ))}
          </div>
        )}

        {partial && results.length > 0 && (
          <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--text-3)', borderTop: '1px solid var(--surface-2)' }}>
            Some results couldn&apos;t be loaded — try again in a moment.
          </div>
        )}

        {status === 'error' && !loading && (
          <div role="alert" style={{ padding: '24px 16px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>
            Search is unavailable right now. Please try again.
          </div>
        )}
        {status === 'rate' && !loading && (
          <div role="alert" style={{ padding: '24px 16px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>
            Too many searches — wait a moment and try again.
          </div>
        )}

        {status === 'ok' && !loading && results.length === 0 && (
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
              // FIX (deep audit, Reports & Audit re-pass): same gap this
              // file's own Portfolio entry was already fixed for — /reports
              // requires VIEW_ALL_PROJECTS in both of its tabs
              // (api/reports/route.ts), but this quick-nav entry was
              // unconditional, unlike Sidebar.tsx's matching link (now
              // also gated — see components/layout/Sidebar.tsx).
              ...(permissions.includes('VIEW_ALL_PROJECTS')
                ? [{ label: 'Reports', href: '/reports', icon: 'ti-chart-bar' }]
                : []),
              ...(permissions.includes('VIEW_PORTFOLIO')
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
