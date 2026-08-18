// components/layout/NotificationBell.tsx
'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

interface Notification {
  id: string
  type: string
  title: string
  body: string
  entity_type: string | null
  entity_id: string | null
  read: boolean
  created_at: string
}

function entityHref(n: Notification): string | null {
  // FIX (audit): invoice_paid / invoice_payment_received / invoice_overdue
  // notifications point at a project (see notify call sites) — route them
  // straight to the Billing tab instead of Overview.
  if (n.entity_type === 'project' && n.entity_id && n.type.startsWith('invoice_'))
    return `/projects/${n.entity_id}?tab=billing`
  if (n.entity_type === 'project' && n.entity_id) return `/projects/${n.entity_id}`
  if (n.entity_type === 'project_message' && n.entity_id) return `/projects/${n.entity_id}?tab=discussion`
  if (n.entity_type === 'approval_request' && n.entity_id) return `/approvals?highlight=${n.entity_id}`
  return null
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function NotificationBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const unreadCount = items.filter(n => !n.read).length

  async function load() {
    try {
      const res = await fetch('/api/notifications')
      const json = await res.json()
      setItems(json.notifications || [])
    } catch { /* fail silently — not worth surfacing an error for this */ }
    finally { setLoaded(true) }
  }

  useEffect(() => {
    load()
    // Lightweight polling — no websocket infra in this app, and a 60s
    // interval is plenty responsive for this without adding real-time
    // infrastructure for what's still a fairly low-frequency event stream.
    const interval = setInterval(load, 60000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  async function markAllRead() {
    setItems(prev => prev.map(n => ({ ...n, read: true })))
    try {
      await fetch('/api/notifications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
    } catch { /* optimistic update already applied; a failed sync here isn't worth surfacing */ }
  }

  async function handleClick(n: Notification) {
    if (!n.read) {
      setItems(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x))
      fetch('/api/notifications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [n.id] }),
      }).catch(() => {})
    }
    const href = entityHref(n)
    setOpen(false)
    if (href) router.push(href)
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Notifications"
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
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 6, width: 320, zIndex: 60,
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
            {loaded && items.length === 0 && (
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
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-1)' }}>{n.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.4 }}>{n.body}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 4 }}>{timeAgo(n.created_at)}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
