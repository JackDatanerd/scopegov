'use client'
// components/layout/AppShell.tsx
//
// The signed-in app frame (.app) and its left-sidebar state. The sidebar can be collapsed so a project, client or invoice tab gets the
// whole screen; the choice is remembered per browser. On a phone the sidebar is an overlay that starts closed and closes itself after
// navigation. Ctrl/Cmd + \ toggles it from anywhere.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'

const STORAGE_KEY = 'sg.sidebar'
const MOBILE_QUERY = '(max-width: 768px)'
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

interface SidebarState { collapsed: boolean; toggle: () => void; setCollapsed: (v: boolean) => void }
const SidebarContext = createContext<SidebarState>({ collapsed: false, toggle: () => {}, setCollapsed: () => {} })
export const useSidebar = () => useContext(SidebarContext)

function readPreference(): boolean | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === 'collapsed' ? true : v === 'expanded' ? false : null
  } catch { return null } // storage can be blocked (private mode); the sidebar then just starts open
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsedState] = useState(false)
  const pathname = usePathname()

  // First paint after hydration: a stored choice wins; with none, a phone starts closed and a desktop starts open.
  useIsoLayoutEffect(() => {
    const stored = readPreference()
    setCollapsedState(stored ?? window.matchMedia(MOBILE_QUERY).matches)
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

  // An overlay sidebar on a phone gets out of the way once a link was followed (not remembered: it is not a choice).
  useEffect(() => {
    if (window.matchMedia(MOBILE_QUERY).matches) setCollapsedState(true)
  }, [pathname])

  // A collapsed sidebar must not stay in the tab order.
  useEffect(() => {
    document.querySelector('.sb')?.toggleAttribute('inert', collapsed)
  }, [collapsed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); toggle() }
      else if (e.key === 'Escape') {
        // Older modals (.modal-bg + .modal) have no key handling of their own: Esc presses their backdrop, which runs the same close
        // logic a click would. Shared dialogs (.dlg-layer) handle Esc themselves and stop it before it gets here.
        const legacy = document.querySelector<HTMLElement>('.modal-bg')
        if (legacy && !document.querySelector('.dlg-layer')) legacy.click()
        else if (window.matchMedia(MOBILE_QUERY).matches) setCollapsedState(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  const value = useMemo(() => ({ collapsed, toggle, setCollapsed }), [collapsed, toggle, setCollapsed])
  return (
    <SidebarContext.Provider value={value}>
      <div className="app" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
        {children}
        <div className="sb-backdrop" onClick={() => setCollapsed(true)} aria-hidden="true" />
      </div>
    </SidebarContext.Provider>
  )
}

/** The slim bar shown at the top of the page while the sidebar is collapsed: the way back, and the mark so the page still says where you are. */
export function SidebarReopenBar() {
  const { collapsed, setCollapsed } = useSidebar()
  if (!collapsed) return null
  return (
    <div className="sb-reopen-bar">
      <button type="button" className="sb-toggle" onClick={() => setCollapsed(false)} aria-label="Show sidebar" title="Show sidebar (Ctrl+\)">
        <i className="ti ti-layout-sidebar-left-expand" />
      </button>
      <span className="sb-reopen-name">ScopeGov</span>
    </div>
  )
}

/** The collapse button inside the sidebar header. */
export function SidebarCollapseButton() {
  const { setCollapsed } = useSidebar()
  return (
    <button type="button" className="sb-toggle" onClick={() => setCollapsed(true)} aria-label="Hide sidebar" title="Hide sidebar (Ctrl+\)">
      <i className="ti ti-layout-sidebar-left-collapse" />
    </button>
  )
}
