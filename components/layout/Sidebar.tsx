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
  { href: '/invoices',  icon: 'ti-receipt-2',         label: 'Invoices' },
  { href: '/approvals', icon: 'ti-shield-check',      label: 'Approvals' },
  // FIX (deep audit, Reports & Audit re-pass): both tabs behind /reports
  // (api/reports's scope and financial modes) require VIEW_ALL_PROJECTS —
  // same workspace-wide rollup reasoning as Portfolio just below, which
  // already gates on it. This link had no `permission` at all, so anyone
  // without that permission could still see it in the nav, click through,
  // and land on a page that (before this pass) silently rendered as an
  // empty report instead of a permission error.
  { href: '/reports',   icon: 'ti-chart-bar',         label: 'Reports', permission: 'VIEW_ALL_PROJECTS' as const },
  // Workspace-wide by definition — only meaningful (and only shown) for
  // anyone who can actually see the whole portfolio.
  { href: '/portfolio', icon: 'ti-building-skyscraper', label: 'Portfolio', permission: 'VIEW_PORTFOLIO' as const },
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
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const switcherRef = useRef<HTMLDivElement>(null)

  // Only members who can actually act on a step (or oversee all of them)
  // need the badge — everyone else would just see a permanently-zero
  // number that means nothing to them.
  const canApprove   = session.permissions.includes('APPROVE_DOCUMENTS')
  const canOverseeAll = session.permissions.includes('VIEW_ALL_PROJECTS')
    || session.permissions.includes('MANAGE_WORKSPACE_SETTINGS')
  const canSeeApprovalCount = canApprove || canOverseeAll

  // FIX (section-11 audit, flagship finding): this always queried
  // scope=mine — which only ever returns steps assigned TO the signed-in
  // member, by name or by role. An oversight-only member (VIEW_ALL_
  // PROJECTS or MANAGE_WORKSPACE_SETTINGS, but not personally an
  // assigned approver on anything) would query 'mine', get back an empty
  // list, and permanently see 0 — contradicting this very comment's "or
  // oversee all of them" rationale for showing them the badge at all.
  // Give an approver their own actionable count; give an oversight-only
  // member the workspace-wide pending total instead, as an FYI rather
  // than an action item.
  const approvalScope = canApprove ? 'mine' : 'all'

  // FIX (fix round, section-11 flagship finding): this only ever counted
  // status='pending' steps assigned to the signed-in member as an
  // approver — a request THEY submitted that fully cleared approval but
  // then failed to auto-send (send_failed_at set — migration 053) never
  // moved this number, no matter how long it sat needing a retry. Worse,
  // an ordinary team member with send permission but none of
  // APPROVE_DOCUMENTS/VIEW_ALL_PROJECTS/MANAGE_WORKSPACE_SETTINGS got no
  // badge here at all (canSeeApprovalCount is false for them), even
  // though the Approvals page's own "needs your attention" banner (see
  // ApprovalsClient) shows exactly this for them via scope=submitted —
  // that request is unconditional (no permission gate), so it's fetched
  // here unconditionally too, independent of canSeeApprovalCount, and
  // summed into the same badge rather than being a second invisible
  // number.
  function refetchPendingApprovals() {
    const requests: Promise<number>[] = []
    if (canSeeApprovalCount) {
      requests.push(
        fetch(`/api/approvals?scope=${approvalScope}`)
          .then(r => r.json())
          .then(json => (json.requests || []).filter((r: any) => r.status === 'pending').length)
          .catch(() => 0)
      )
    }
    requests.push(
      fetch(`/api/approvals?scope=submitted`)
        .then(r => r.json())
        .then(json => (json.requests || []).filter((r: any) => !!r.send_failed_at).length)
        .catch(() => 0)
    )
    Promise.all(requests).then(counts => setPendingApprovals(counts.reduce((a, b) => a + b, 0)))
  }

  useEffect(() => {
    refetchPendingApprovals()
    // FIX (section-11 audit, flagship finding): this only ever re-ran on
    // a `pathname` change — approving/rejecting/cancelling a request from
    // the Approvals page itself doesn't navigate anywhere, so the badge
    // sat stale (still showing the pre-action count) for the rest of
    // that visit. ApprovalsClient now dispatches this event right after
    // any successful decision; listen for it as a second trigger
    // alongside the existing pathname-change refetch.
    window.addEventListener('scopegov:approvals-changed', refetchPendingApprovals)
    return () => window.removeEventListener('scopegov:approvals-changed', refetchPendingApprovals)
  }, [canSeeApprovalCount, approvalScope, pathname])

  const daysLeft = session.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(session.trialEndsAt).getTime() - Date.now()) / 86400000))
    : null

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard'
    return pathname.startsWith(href)
  }

  // FIX (deep audit, Auth+MFA section): supabase-js defaults signOut() to
  // `scope: 'global'`, which revokes EVERY session for this user, not just
  // this browser — so the everyday "Sign out" button was silently logging
  // people out of their phone app / other browser / other tab too. That
  // directly undercut the dedicated "sign out of other sessions" feature
  // (see SettingsClient.tsx's /api/auth/signout-others), which exists
  // specifically so a normal logout doesn't have to be that aggressive.
  // reset-password and change-password intentionally rely on the global
  // default for a real security reason (invalidate everywhere after a
  // password change) — this action never had that rationale; it's just
  // "I'm done for now," and should only end the current session.
  async function signOut() {
    await supabase.auth.signOut({ scope: 'local' })
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
            {/* FIX (round 3, Workspace lifecycle Finding 1 — severe): this
                used to link straight to /onboarding with no signal of
                intent. onboarding-status returns 'complete' the instant
                the user has ANY already-onboarded active membership —
                true for virtually every existing user — which immediately
                bounces /onboarding to /dashboard. Since this is the ONLY
                caller of this link in the entire app, and POST
                /api/workspace/create is only ever invoked from
                app/onboarding/page.tsx, there was literally no way for an
                existing user to ever create a second workspace. The
                ?new=1 flag tells the onboarding page to bypass the
                status/resume check entirely and start a genuinely new
                workspace. */}
            <Link href="/onboarding?new=1" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', fontSize: 12.5, color: 'var(--text-2)', borderTop: '1px solid var(--border)' }}>
              <i className="ti ti-plus" style={{ fontSize: 12 }} /> Create new workspace
            </Link>
          </div>
        )}
      </div>

      {/* Primary nav */}
      <nav className="sb-nav">
        <div className="sb-section-lbl">Workspace</div>
        {NAV_ITEMS.filter(item => !item.permission || session.permissions.includes(item.permission)).map(item => (
          <Link key={item.href} href={item.href}>
            <button className={`sni${isActive(item.href) ? ' act' : ''}`}>
              <span className="sni-ic"><i className={`ti ${item.icon}`} /></span>
              {item.label}
              {item.href === '/approvals' && pendingApprovals > 0 && (
                <span className="sni-badge">{pendingApprovals}</span>
              )}
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
          {/* FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
              feature gap): session.avatarUrl was already threaded all the
              way into SessionUser but never rendered here — the sidebar's
              own user row, arguably the single most-visible avatar spot in
              the app, showed initials for every account regardless of
              whether they'd set a photo, because there was nowhere in the
              app to set one. See api/workspace/profile/avatar/route.ts. */}
          {session.avatarUrl ? (
            <img src={session.avatarUrl} alt="" className="sb-av" style={{ objectFit: 'cover' }} />
          ) : (
            <div className="sb-av" style={{ background: avatarColour(session.name) }}>
              {initials(session.name)}
            </div>
          )}
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
