'use client'
import { useState, useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { SessionUser } from '@/lib/supabase/types'
import { PLAN_LABELS, initials, avatarColour } from '@/lib/utils/format'
import NotificationBell from './NotificationBell'

const NAV_ITEMS = [
  { href: '/dashboard', icon: 'ti-layout-dashboard', label: 'Dashboard' },
  { href: '/projects',  icon: 'ti-folder-open',      label: 'Projects' },
  { href: '/clients',   icon: 'ti-users',             label: 'Clients' },
  { href: '/sow',       icon: 'ti-file-description',  label: 'SOW Registry' },
  { href: '/reports',   icon: 'ti-chart-bar',         label: 'Reports' },
]
const BOTTOM_NAV = [
  { href: '/team',     icon: 'ti-user-circle', label: 'Team' },
  { href: '/settings', icon: 'ti-settings',    label: 'Settings' },
]

type WorkspaceOption = {
  id: string; name: string; agencyName: string; logoUrl: string | null; planTier: string; active: boolean
}

export default function Sidebar({ session }: { session: SessionUser }) {
  const pathname = usePathname()
  const router   = useRouter()
  const supabase = createClient()

  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [workspaces,   setWorkspaces]   = useState<WorkspaceOption[]>([])
  const [switching,    setSwitching]    = useState(false)
  const [leavingId,    setLeavingId]    = useState<string | null>(null)
  const switcherRef = useRef<HTMLDivElement>(null)

  const daysLeft = session.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(session.trialEndsAt).getTime() - Date.now()) / 86400000))
    : null

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard'
    return pathname.startsWith(href)
  }

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  function openSwitcher() {
    setSwitcherOpen(o => !o)
    if (!switcherOpen && workspaces.length === 0) {
      fetch('/api/workspace/list').then(r => r.json()).then(json => setWorkspaces(json.workspaces || [])).catch(() => {})
    }
  }

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) setSwitcherOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  async function switchWorkspace(workspaceId: string) {
    if (switching) return
    setSwitching(true)
    try {
      const res = await fetch('/api/workspace/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      if (res.ok) {
        // Full reload rather than router.refresh() — every server component
        // in the tree reads session data derived from active_workspace_id,
        // and a hard navigation is the simplest way to guarantee all of it
        // (not just the current route) reflects the new workspace.
        window.location.href = '/dashboard'
      }
    } finally { setSwitching(false) }
  }

  async function leaveWorkspace(workspaceId: string, name: string) {
    if (!confirm(`Leave "${name}"? You'll need a new invite to rejoin.`)) return
    setLeavingId(workspaceId)
    try {
      const res  = await fetch('/api/workspace/leave', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      const json = await res.json()
      if (!res.ok) { alert(json.error || 'Could not leave that workspace.'); return }
      setWorkspaces(prev => prev.filter(w => w.id !== workspaceId))
    } finally { setLeavingId(null) }
  }

  const logoUrl = session.logoStoragePath
    ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/logos/${session.logoStoragePath}`
    : null

  return (
    <aside className="sb">
      {/* Brand + workspace switcher */}
      <div className="sb-brand" ref={switcherRef} style={{ position: 'relative' }}>
        <div className="sb-logo-row" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {logoUrl ? (
              <img src={logoUrl} alt={session.agencyName} className="sb-mark" style={{ objectFit: 'cover' }} />
            ) : (
              <div className="sb-mark">
                <i className="ti ti-scale" style={{ fontSize: 15, color: '#FFF' }} />
              </div>
            )}
            <span className="sb-name">ScopeGov</span>
          </div>
          <NotificationBell />
        </div>
        <button
          onClick={openSwitcher}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}
          aria-haspopup="listbox" aria-expanded={switcherOpen}
        >
          <span className="sb-agency" style={{ flex: 1 }}>{session.agencyName}</span>
          <i className="ti ti-chevron-down" style={{ fontSize: 11, color: 'var(--text-3, #909090)', transform: switcherOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
        </button>

        {switcherOpen && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6, zIndex: 50,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)', overflow: 'hidden',
          }}>
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              {workspaces.length === 0 && (
                <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--text-3)' }}>Loading workspaces…</div>
              )}
              {workspaces.map(ws => (
                <div key={ws.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px',
                    background: ws.active ? 'var(--surface-2)' : 'transparent',
                    borderBottom: '1px solid var(--surface-2)',
                  }}>
                  <button onClick={() => !ws.active && switchWorkspace(ws.id)} disabled={switching}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
                      background: 'none', border: 'none', padding: 0, cursor: ws.active ? 'default' : 'pointer', textAlign: 'left',
                    }}>
                    <div style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                      {ws.logoUrl
                        ? <img src={ws.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <i className="ti ti-building" style={{ fontSize: 13, color: 'var(--text-3)' }} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.agencyName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{PLAN_LABELS[ws.planTier as keyof typeof PLAN_LABELS] ?? ws.planTier}</div>
                    </div>
                  </button>
                  {ws.active && <i className="ti ti-check" style={{ fontSize: 14, color: 'var(--green)', flexShrink: 0 }} />}
                  {!ws.active && (
                    <button onClick={() => leaveWorkspace(ws.id, ws.agencyName)} disabled={switching || leavingId === ws.id}
                      title={`Leave ${ws.agencyName}`} aria-label={`Leave ${ws.agencyName}`}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-4)', flexShrink: 0 }}>
                      {leavingId === ws.id ? <span className="spin spin-dark" style={{ width: 11, height: 11 }} /> : <i className="ti ti-logout-2" style={{ fontSize: 13 }} />}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <Link href="/onboarding" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', fontSize: 12.5, color: 'var(--text-2)', borderTop: '1px solid var(--border)' }}>
              <i className="ti ti-plus" style={{ fontSize: 12 }} /> Create new workspace
            </Link>
          </div>
        )}
      </div>

      {/* Primary nav */}
      <nav className="sb-nav">
        <div className="sb-section-lbl">Workspace</div>
        {NAV_ITEMS.map(item => (
          <Link key={item.href} href={item.href}>
            <button className={`sni${isActive(item.href) ? ' act' : ''}`}>
              <span className="sni-ic"><i className={`ti ${item.icon}`} /></span>
              {item.label}
            </button>
          </Link>
        ))}

        <div className="sb-divider" style={{ margin: '10px 0' }} />
        <div className="sb-section-lbl">Account</div>
        {BOTTOM_NAV.map(item => (
          <Link key={item.href} href={item.href}>
            <button className={`sni${isActive(item.href) ? ' act' : ''}`}>
              <span className="sni-ic"><i className={`ti ${item.icon}`} /></span>
              {item.label}
            </button>
          </Link>
        ))}
      </nav>

      {/* Footer */}
      <div className="sb-footer">
        {/* Plan / trial */}
        <div className="sb-plan-tag">
          <div>
            <div className="sb-plan-name">
              {PLAN_LABELS[session.planTier] ?? session.planTier}
              {session.planTier === 'trial' && daysLeft !== null && ` · ${daysLeft}d left`}
            </div>
            {session.planTier === 'trial' && daysLeft !== null && (
              <>
                <div className="sb-trial-bar">
                  <div className="sb-trial-fill" style={{ width: `${Math.round((daysLeft / 14) * 100)}%` }} />
                </div>
                <div className="sb-trial-txt">{daysLeft} of 14 trial days remaining</div>
              </>
            )}
          </div>
          {(session.planTier === 'trial' || session.planTier === 'solo') && (
            <Link href="/settings?tab=billing">
              <button className="sb-plan-action">Upgrade</button>
            </Link>
          )}
        </div>

        {/* User row */}
        <div className="sb-user">
          <div className="sb-av" style={{ background: avatarColour(session.name) }}>
            {initials(session.name)}
          </div>
          <div className="sb-user-info">
            <div className="sb-user-name">{session.name}</div>
            <div className="sb-user-email">{session.email}</div>
          </div>
        </div>

        <button className="sb-signout" onClick={signOut}>
          <i className="ti ti-logout" style={{ fontSize: 13 }} />
          Sign out
        </button>
      </div>
    </aside>
  )
}
