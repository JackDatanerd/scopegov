'use client'
// components/layout/AppShell.tsx
//
// The signed-in app frame (.app) and its left-sidebar state. The sidebar can be collapsed so a project, client or invoice tab gets the
// whole screen; the choice is remembered per browser. On a phone the sidebar is an overlay that starts closed and closes itself after
// navigation. Ctrl/Cmd + \ toggles it from anywhere.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

const STORAGE_KEY = 'sg.sidebar'
const WIDTH_KEY = 'sg.width'
const MOBILE_QUERY = '(max-width: 768px)'
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

interface SidebarState { collapsed: boolean; toggle: () => void; setCollapsed: (v: boolean) => void; fullWidth: boolean; toggleWidth: () => void; peek: boolean; peekHandlers: { onMouseEnter: () => void; onMouseLeave: () => void } }
const SidebarContext = createContext<SidebarState>({ collapsed: false, toggle: () => {}, setCollapsed: () => {}, fullWidth: false, toggleWidth: () => {}, peek: false, peekHandlers: { onMouseEnter: () => {}, onMouseLeave: () => {} } })
export const useSidebar = () => useContext(SidebarContext)

function readPreference(): boolean | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === 'collapsed' ? true : v === 'expanded' ? false : null
  } catch { return null } // storage can be blocked (private mode); the sidebar then just starts open
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsedState] = useState(false)
  // Page width: 'centered' (a readable column, centred) or 'full' (content fills the whole space). Remembered per browser.
  const [fullWidth, setFullWidth] = useState(false)
  // Peek: while the sidebar is collapsed, hovering the reopen button (or the left screen edge) floats the navigation over the page so
  // the next page is one click away without reopening the sidebar. Hover-intent timers stop a passing mouse from flashing it open.
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearPeekTimer = () => { if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null } }
  const peekHandlers = useMemo(() => ({
    onMouseEnter: () => { clearPeekTimer(); peekTimer.current = setTimeout(() => setPeek(true), 120) },
    onMouseLeave: () => { clearPeekTimer(); peekTimer.current = setTimeout(() => setPeek(false), 280) },
  }), [])
  const pathname = usePathname()

  // First paint after hydration: a stored choice wins; with none, a phone starts closed and a desktop starts open.
  useIsoLayoutEffect(() => {
    const stored = readPreference()
    setCollapsedState(stored ?? window.matchMedia(MOBILE_QUERY).matches)
    try { setFullWidth(window.localStorage.getItem(WIDTH_KEY) === 'full') } catch { /* blocked storage: centred */ }
  }, [])

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v)
    try { window.localStorage.setItem(STORAGE_KEY, v ? 'collapsed' : 'expanded') } catch { /* not remembered, still works */ }
  }, [])
  const toggle = useCallback(() => setCollapsedState(prev => {
    const next = !prev
    try { window.localStorage.setItem(STORAGE_KEY, next ? 'collapsed' : 'expanded') } catch { /* not remembered, still works */ }
    return next
  }), [])

  const toggleWidth = useCallback(() => setFullWidth(prev => {
    const next = !prev
    try { window.localStorage.setItem(WIDTH_KEY, next ? 'full' : 'centered') } catch { /* not remembered, still works */ }
    return next
  }), [])

  // An overlay sidebar on a phone gets out of the way once a link was followed (not remembered: it is not a choice).
  useEffect(() => {
    if (window.matchMedia(MOBILE_QUERY).matches) setCollapsedState(true)
    setPeek(false) // following a link from the floating navigation closes it
  }, [pathname])
  useEffect(() => { if (!collapsed) setPeek(false) }, [collapsed])

  // A collapsed sidebar must not stay in the tab order.
  useEffect(() => {
    document.querySelector('.sb')?.toggleAttribute('inert', collapsed && !peek)
  }, [collapsed, peek])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '|' || e.key === '\\')) { e.preventDefault(); toggleWidth() }
      else if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); toggle() }
      else if (e.key === 'Escape') {
        // Older modals (.modal-bg + .modal) have no key handling of their own: Esc presses their backdrop, which runs the same close
        // logic a click would. Shared dialogs (.dlg-layer) handle Esc themselves and stop it before it gets here.
        const legacy = document.querySelector<HTMLElement>('.modal-bg')
        if (legacy && !document.querySelector('.dlg-layer')) legacy.click()
        else if (peekOpenRef.current) setPeek(false)
        else if (window.matchMedia(MOBILE_QUERY).matches) setCollapsedState(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle, toggleWidth])

  const peekOpenRef = useRef(false)
  peekOpenRef.current = peek
  const value = useMemo(() => ({ collapsed, toggle, setCollapsed, fullWidth, toggleWidth, peek, peekHandlers }), [collapsed, toggle, setCollapsed, fullWidth, toggleWidth, peek, peekHandlers])
  return (
    <SidebarContext.Provider value={value}>
      <div className="app" data-sidebar={collapsed ? 'collapsed' : 'expanded'} data-width={fullWidth ? 'full' : 'centered'} data-peek={collapsed && peek ? 'open' : 'closed'}>
        {children}
        {collapsed && <div className="sb-edge" {...peekHandlers} aria-hidden="true" />}
        <div className="sb-backdrop" onClick={() => setCollapsed(true)} aria-hidden="true" />
      </div>
    </SidebarContext.Provider>
  )
}

/** The slim bar shown at the top of the page while the sidebar is collapsed: the way back, and the mark so the page still says where you are. */
export function SidebarReopenBar() {
  const { collapsed, setCollapsed, peekHandlers } = useSidebar()
  if (!collapsed) return null
  return (
    <div className="sb-reopen-bar">
      <button type="button" className="sb-toggle" onClick={() => setCollapsed(false)} {...peekHandlers} aria-label="Show sidebar" title="Show sidebar (Ctrl+\). Hover to peek at the navigation.">
        <i className="ti ti-layout-sidebar-left-expand" />
      </button>
      <span className="sb-reopen-name">ScopeGov</span>
      <span style={{ flex: 1 }} />
      <PageWidthButton />
    </div>
  )
}

/** The collapse button inside the sidebar header. */
export function SidebarCollapseButton() {
  const { collapsed, setCollapsed } = useSidebar()
  // While the sidebar is only peeking over a collapsed page, this button keeps it open instead.
  return collapsed ? (
    <button type="button" className="sb-toggle" onClick={() => setCollapsed(false)} aria-label="Keep sidebar open" title="Keep the sidebar open">
      <i className="ti ti-pin" />
    </button>
  ) : (
    <button type="button" className="sb-toggle" onClick={() => setCollapsed(true)} aria-label="Hide sidebar" title="Hide sidebar (Ctrl+\\)">
      <i className="ti ti-layout-sidebar-left-collapse" />
    </button>
  )
}

/** Switches pages between a centred readable column and content that fills the whole space. */
export function PageWidthButton() {
  const { fullWidth, toggleWidth } = useSidebar()
  return (
    <button type="button" className="sb-toggle" onClick={toggleWidth} aria-pressed={fullWidth}
      aria-label={fullWidth ? 'Use centred page width' : 'Use full page width'}
      title={fullWidth ? 'Page width: full. Click for centred (Ctrl+Shift+\\)' : 'Page width: centred. Click for full (Ctrl+Shift+\\)'}>
      <i className={`ti ti-${fullWidth ? 'arrows-minimize' : 'arrows-maximize'}`} style={{ transform: 'rotate(45deg)' }} />
    </button>
  )
}
