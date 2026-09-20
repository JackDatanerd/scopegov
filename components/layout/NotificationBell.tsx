// components/layout/NotificationBell.tsx
'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { notificationHref, timeAgo, type AppNotification } from '@/lib/utils/notification-links'

type Notification = AppNotification
const entityHref = notificationHref

export default function NotificationBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [loaded, setLoaded] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const [loadError, setLoadError] = useState(false)

  // FIX (Notifications & email fix round): load() never looked at res.ok. A 401 (expired session)
  // or 500 parsed as JSON with no `notifications`, so the list and the unread badge were
  // replaced with "empty" — indistinguishable from having no notifications. A failed refresh
  // now keeps what was already showing and says so only if there is nothing to show.
  async function load() {
    try {
      const res = await fetch('/api/notifications')
      if (!res.ok) throw new Error(String(res.status))
      const json = await res.json()
      setItems(json.notifications || [])
      setUnreadCount(json.unreadCount ?? (json.notifications || []).filter((n: Notification) => !n.read).length)
      setLoadError(false)
    } catch { setLoadError(true) }
    finally { setLoaded(true) }
  }

  useEffect(() => {
    load()
    // Lightweight polling — no websocket infra in this app. FIX: it used to keep polling every
    // 60s in background tabs and did not refresh when the user came back to the tab, so the badge
    // could be up to a minute stale on return. Poll only while visible, and refresh on return.
    const tick = () => { if (document.visibilityState === 'visible') load() }
    const interval = setInterval(tick, 60000)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', tick)
    }
  }, [])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', onKey) }
  }, [])

  // Optimistic updates, but a failed write resyncs from the server instead of leaving the badge
  // claiming everything is read while the next poll quietly brings the unread rows back.
  async function markAllRead() {
    setItems(prev => prev.map(n => ({ ...n, read: true })))
    setUnreadCount(0)
    try {
      const res = await fetch('/api/notifications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      if (!res.ok) throw new Error(String(res.status))
    } catch { load() }
  }

  async function handleClick(n: Notification) {
    if (!n.read) {
      setItems(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x))
      setUnreadCount(prev => Math.max(0, prev - 1))
      fetch('/api/notifications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [n.id] }),
      }).then(res => { if (!res.ok) load() }).catch(() => load())
    }
    const href = entityHref(n)
    setOpen(false)
    if (href) router.push(href)
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          position: 'relative', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer',
          color: 'var(--text-2, #555555)',
        }}
      >
        <i className="ti ti-bell" style={{ fontSize: 16 }} />
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2, minWidth: 15, height: 15, padding: '0 3px',
            background: 'var(--red, #B91C1C)', color: '#fff', borderRadius: 8,
            fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1,
          }}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Notifications" style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 6, width: 320, maxWidth: 'calc(100vw - 24px)', zIndex: 60,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)', overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--surface-2)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-1)' }}>Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} style={{ background: 'none', border: 'none', fontSize: 11, color: 'var(--green)', cursor: 'pointer' }}>
                Mark all read
              </button>
            )}
          </div>
          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            {!loaded && <div style={{ padding: '20px 12px', fontSize: 12, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>}
            {loaded && items.length === 0 && loadError && (
              <div style={{ padding: '24px 12px', fontSize: 12, color: 'var(--text-3)', textAlign: 'center' }}>
                Couldn&apos;t load notifications.{' '}
                <button onClick={load} style={{ background: 'none', border: 'none', color: 'var(--green)', cursor: 'pointer', fontSize: 12 }}>Try again</button>
              </div>
            )}
            {loaded && items.length === 0 && !loadError && (
              <div style={{ padding: '28px 12px', fontSize: 12, color: 'var(--text-3)', textAlign: 'center' }}>
                <i className="ti ti-bell-off" style={{ fontSize: 20, display: 'block', margin: '0 auto 8px', color: 'var(--text-4)' }} />
                No notifications yet
              </div>
            )}
            {items.map(n => (
              <button key={n.id} onClick={() => handleClick(n)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
                  background: n.read ? 'transparent' : 'var(--green-lt, #EDFAF2)', border: 'none',
                  borderBottom: '1px solid var(--surface-2)', cursor: entityHref(n) ? 'pointer' : 'default',
                }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  {!n.read && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', marginTop: 5, flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-1)', overflowWrap: 'anywhere' }}>{n.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{n.body}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 4 }}>{timeAgo(n.created_at)}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
          <Link href="/notifications" onClick={() => setOpen(false)}
            style={{ display: 'block', padding: '9px 12px', textAlign: 'center', fontSize: 11.5, color: 'var(--green)', borderTop: '1px solid var(--surface-2)', textDecoration: 'none' }}>
            View all notifications
          </Link>
        </div>
      )}
    </div>
  )
}
