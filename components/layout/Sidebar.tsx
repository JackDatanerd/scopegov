'use client'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { SessionUser } from '@/lib/supabase/types'
import { PLAN_LABELS, initials, avatarColour } from '@/lib/utils/format'

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

export default function Sidebar({ session }: { session: SessionUser }) {
  const pathname = usePathname()
  const router   = useRouter()
  const supabase = createClient()

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

  return (
    <aside className="sb">
      {/* Brand */}
      <div className="sb-brand">
        <div className="sb-logo-row">
          <div className="sb-mark">
            <i className="ti ti-scale" style={{ fontSize: 15, color: '#FFF' }} />
          </div>
          <span className="sb-name">ScopeGov</span>
        </div>
        <div className="sb-agency">{session.agencyName}</div>
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
