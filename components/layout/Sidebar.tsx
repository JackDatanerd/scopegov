'use client'
import { useState, useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { SessionUser } from '@/lib/supabase/types'
import { PLAN_LABELS, initials, avatarColour } from '@/lib/utils/format'
import { trialBarPercent } from '@/lib/billing/plans'
import NotificationBell from './NotificationBell'

const NAV_ITEMS = [
  { href: '/dashboard', icon: 'ti-layout-dashboard', label: 'Dashboard' },
  { href: '/projects',  icon: 'ti-folder-open',      label: 'Projects' },
  { href: '/clients',   icon: 'ti-users',             label: 'Clients' },
  { href: '/sow',       icon: 'ti-file-description',  label: 'SOW Registry' },
  // FIX (Search section, round 12 — traced from the command palette): this entry had no `permission`, but
  // app/(app)/invoices/page.tsx redirects to /dashboard for anyone without VIEW_FINANCIALS — so those members saw an
  // Invoices link that just bounced them. The palette's quick-nav already gates it this way ("match the sidebar
  // exactly"); the sidebar itself was the one left behind.
  { href: '/invoices',  icon: 'ti-receipt-2',         label: 'Invoices', permission: 'VIEW_FINANCIALS' as const },
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
  // Round 21: a failed /api/workspace/list used to leave the menu on "Loading workspaces…" forever.
  const [listError,    setListError]    = useState(false)
  const [switching,    setSwitching]    = useState(false)
  const [leavingId,    setLeavingId]    = useState<string | null>(null)
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
  // gap): workspace/restore (migration 065) was only ever reachable from
  // the onboarding page's own 'create' gate — which only renders when
  // onboarding-status has NOTHING active to show the user. The instant
  // someone has even one other active membership (their own second
  // workspace, or just being invited somewhere else), onboarding-status
  // resolves 'complete' and bounces straight to /dashboard before that
  // gate — and its restore-fetch effect — ever mounts. There was no
  // restore entry point anywhere else in the app. This switcher is
  // already the one place an existing user reaches regardless of
  // onboarding status (see the "Create new workspace" link just below,
  // fixed for the identical reachability gap in round 3) — surfacing
  // restore here too closes it the same way.
  const [restorable,   setRestorable]   = useState<Array<{ id: string; agencyName: string }>>([])
  const [restoringId,  setRestoringId]  = useState<string | null>(null)
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
        // FIX (section-11 audit, B7): scope=all is the oversight view — every request in the workspace, any
        // status, ever. This badge only counts pending ones, so filter server-side instead of paging the whole
        // history down on every navigation. (scope=mine is already pending-only by construction.)
        // FIX (section-11 audit, pass 1 — B2): `light=1` returns just { count } (slim select, no lazy heal)
        // instead of every request with its four embeds on every navigation.
        fetch(`/api/approvals?scope=${approvalScope}&light=1${approvalScope === 'all' ? '&status=pending' : ''}`)
          .then(r => r.json())
          .then(json => (typeof json.count === 'number' ? json.count : 0))
          .catch(() => 0)
      )
    }
    // send_failed_at is only ever set on a request that is (still) status='approved' — see
    // engine.ts's own send_failed_at comments — so this can filter server-side instead of
    // paging through every rejected/cancelled/successfully-sent request this member has ever
    // submitted, on every navigation, just to throw almost all of it away client-side.
    requests.push(
      // FIX (section-11 audit, pass 1 — B2): this asked for status=approved and threw away everything
      // without send_failed_at CLIENT-side — i.e. it downloaded every approved request the member had ever
      // submitted, on every navigation. `sendFailed=1` filters in the query itself.
      fetch(`/api/approvals?scope=submitted&sendFailed=1&light=1`)
        .then(r => r.json())
        .then(json => (typeof json.count === 'number' ? json.count : 0))
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

  function loadWorkspaces() {
    setListError(false)
    fetch('/api/workspace/list')
      .then(async r => {
        const json = await r.json().catch(() => ({}))
        if (!r.ok || !Array.isArray(json.workspaces)) { setListError(true); return }
        setWorkspaces(json.workspaces)
      })
      .catch(() => setListError(true))
  }

  function openSwitcher() {
    setSwitcherOpen(o => !o)
    // FIX (Workspace lifecycle independent pass 24 — B2): the list was fetched only while empty, so after a rename,
    // an upgrade or a logo change in this same session the switcher kept showing the old agency name, plan label
    // and logo (the header above it uses fresh session data and disagreed). Refetch on every open; a failed
    // refresh keeps the last list (the error row only renders when the list is empty).
    if (!switcherOpen) loadWorkspaces()
    // Best-effort, same as the workspace list fetch above — a failed
    // lookup just means the "recently deleted" section doesn't show,
    // never a blocker for the switcher itself.
    if (!switcherOpen) {
      fetch('/api/workspace/restore').then(r => r.json()).then(json => { if (Array.isArray(json.restorable)) setRestorable(json.restorable) }).catch(() => {})
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
        return
      }
      // FIX (Workspace lifecycle independent pass — B6): a refused switch (the workspace was
      // deleted or the person was removed since the list loaded, a 403/404, a 500) used to do
      // nothing at all — the spinner cleared and the menu just sat there. Say so, and drop the
      // stale entry's ambiguity by telling them to reload.
      const json = await res.json().catch(() => ({}))
      alert(json.error || 'Could not switch to that workspace. Reload the page and try again.')
    } catch {
      alert('Could not reach the server to switch workspaces. Check your connection and try again.')
    } finally { setSwitching(false) }
  }

  async function restoreWorkspace(workspaceId: string, name: string) {
    if (!confirm(`Restore "${name}"? It'll come back exactly as it was when it was deleted.`)) return
    setRestoringId(workspaceId)
    try {
      const res  = await fetch('/api/workspace/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { alert(json.error || 'Could not restore that workspace.'); return }
      // Full reload, same reasoning as switchWorkspace above — every
      // server component reading session data off active_workspace_id
      // needs to see the newly-restored workspace.
      window.location.href = '/dashboard'
    } catch {
      alert('Could not reach the server to restore that workspace. Check your connection and try again.')
    } finally { setRestoringId(null) }
  }

  async function leaveWorkspace(workspaceId: string, name: string) {
    if (!confirm(`Leave "${name}"? You'll need a new invite to rejoin.`)) return
    setLeavingId(workspaceId)
    try {
      const res  = await fetch('/api/workspace/leave', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      // .catch: a gateway error page (502/504) isn't JSON and made this throw with no feedback.
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { alert(json.error || 'Could not leave that workspace.'); return }
      setWorkspaces(prev => prev.filter(w => w.id !== workspaceId))
    } catch {
      alert('Could not reach the server to leave that workspace. Check your connection and try again.')
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
              {workspaces.length === 0 && !listError && (
                <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--text-3)' }}>Loading workspaces…</div>
              )}
              {workspaces.length === 0 && listError && (
                <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--text-3)' }}>
                  Couldn&apos;t load your workspaces.{' '}
                  <button type="button" onClick={loadWorkspaces}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-2)', textDecoration: 'underline', fontSize: 12 }}>
                    Retry
                  </button>
                </div>
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
            {restorable.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px' }}>
                <p style={{ fontSize: 10.5, color: 'var(--text-3)', marginBottom: 4 }}>Recently deleted</p>
                {restorable.map(w => (
                  <button key={w.id} type="button" onClick={() => restoreWorkspace(w.id, w.agencyName)}
                    disabled={restoringId === w.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', fontSize: 12, color: 'var(--text-2)' }}>
                    {restoringId === w.id
                      ? <span className="spin spin-dark" style={{ width: 11, height: 11 }} />
                      : <i className="ti ti-history" style={{ fontSize: 12 }} />}
                    Restore &quot;{w.agencyName}&quot;
                  </button>
                ))}
              </div>
            )}
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
              {session.lapsed ? 'No plan · read-only' : (PLAN_LABELS[session.planTier] ?? session.planTier)}
              {!session.lapsed && session.planTier === 'trial' && daysLeft !== null && ` · ${daysLeft}d left`}
            </div>
            {session.planTier === 'trial' && daysLeft !== null && (
              <>
                <div className="sb-trial-bar">
                  {/* FIX (Trial/plan/workspace pass): the bar and the label both hardcoded a 14-day total, so an
                      admin-extended trial (extend-trial allows up to 365 days) read "60 of 14" with a bar wider than its track. */}
                  <div className="sb-trial-fill" style={{ width: `${trialBarPercent(daysLeft)}%` }} />
                </div>
                <div className="sb-trial-txt">{daysLeft} trial day{daysLeft === 1 ? '' : 's'} remaining</div>
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
