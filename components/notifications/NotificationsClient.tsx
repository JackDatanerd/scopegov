// components/notifications/NotificationsClient.tsx
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { notificationHref, timeAgo, type AppNotification } from '@/lib/utils/notification-links'

type Filter = 'all' | 'unread'

export default function NotificationsClient() {
  const router = useRouter()
  const [items, setItems] = useState<AppNotification[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [unreadCount, setUnreadCount] = useState(0)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  // Bumped by every reload; a page that comes back for an older reload (the person flipped All ↔ Unread
  // quickly, or reloaded after "Mark all read" while an earlier request was still on the wire) is dropped
  // instead of overwriting the list that belongs to the current filter.
  const reloadSeq = useRef(0)

  const fetchPage = useCallback(async (f: Filter, after: string | null) => {
    const qs = new URLSearchParams({ limit: '30' })
    if (f === 'unread') qs.set('unread', '1')
    if (after) qs.set('cursor', after)
    const res = await fetch(`/api/notifications?${qs.toString()}`)
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || 'Could not load notifications')
    return json as { notifications: AppNotification[]; unreadCount: number; hasMore: boolean; nextCursor: string | null }
  }, [])

  const reload = useCallback(async (f: Filter) => {
    const mySeq = ++reloadSeq.current
    setLoading(true); setError('')
    try {
      const page = await fetchPage(f, null)
      if (mySeq !== reloadSeq.current) return
      setItems(page.notifications); setUnreadCount(page.unreadCount)
      setHasMore(page.hasMore); setCursor(page.nextCursor)
    } catch (e: unknown) {
      if (mySeq === reloadSeq.current) setError(e instanceof Error ? e.message : 'Could not load notifications')
    } finally { if (mySeq === reloadSeq.current) setLoading(false) }
  }, [fetchPage])

  useEffect(() => { reload(filter) }, [filter, reload])

  async function loadMore() {
    if (!cursor) return
    const mySeq = reloadSeq.current
    setLoadingMore(true); setError('')
    try {
      const page = await fetchPage(filter, cursor)
      if (mySeq !== reloadSeq.current) return // the list was reloaded (filter changed) while this page loaded
      setItems(prev => {
        const seen = new Set(prev.map(n => n.id))
        return [...prev, ...page.notifications.filter(n => !seen.has(n.id))]
      })
      setUnreadCount(page.unreadCount); setHasMore(page.hasMore); setCursor(page.nextCursor)
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not load more') }
    finally { setLoadingMore(false) }
  }

  async function call(method: 'PATCH' | 'DELETE', body: Record<string, unknown>) {
    const res = await fetch('/api/notifications', {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.error || 'Request failed')
    }
  }

  async function markAllRead() {
    setError('')
    try { await call('PATCH', { all: true }); await reload(filter) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not mark as read') }
  }

  async function clearRead() {
    if (!confirm('Delete all notifications you have already read? This cannot be undone.')) return
    setError('')
    try { await call('DELETE', { allRead: true }); await reload(filter) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not clear notifications') }
  }

  async function remove(n: AppNotification) {
    setError('')
    const before = items
    setItems(prev => prev.filter(x => x.id !== n.id))
    if (!n.read) setUnreadCount(c => Math.max(0, c - 1))
    try { await call('DELETE', { ids: [n.id] }) }
    catch (e: unknown) { setItems(before); setError(e instanceof Error ? e.message : 'Could not delete') ; reload(filter) }
  }

  async function open(n: AppNotification) {
    const href = notificationHref(n)
    if (!n.read) {
      setItems(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x))
      setUnreadCount(c => Math.max(0, c - 1))
      // Fire and forget: navigation must not wait on it. A rejected request (fetch only throws on a
      // network error — an HTTP 4xx/5xx resolves) puts the row back to unread instead of lying.
      fetch('/api/notifications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [n.id] }),
      }).then(res => {
        if (!res.ok) throw new Error('mark-read failed')
      }).catch(() => {
        setItems(prev => prev.map(x => x.id === n.id ? { ...x, read: false } : x))
        setUnreadCount(c => c + 1)
      })
    }
    if (href) router.push(href)
  }

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-sub">
            {unreadCount > 0 ? `${unreadCount} unread` : 'You\u2019re all caught up'}
            {' · '}
            <Link href="/settings?tab=notifications" style={{ color: 'var(--green)' }}>Notification settings</Link>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={markAllRead} disabled={unreadCount === 0}>
            <i className="ti ti-checks" style={{ fontSize: 12 }} /> Mark all read
          </button>
          <button className="btn btn-ghost btn-sm" onClick={clearRead}>
            <i className="ti ti-trash" style={{ fontSize: 12 }} /> Clear read
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }} role="tablist" aria-label="Filter notifications">
        {(['all', 'unread'] as Filter[]).map(f => (
          <button key={f} role="tab" aria-selected={filter === f}
            className={filter === f ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : 'Unread'}
          </button>
        ))}
      </div>

      {error && (
        <div className="surface surface-p" style={{ marginBottom: 12, borderColor: 'var(--red)', color: 'var(--red)', fontSize: 12.5 }} role="alert">
          {error}
        </div>
      )}

      <div className="surface" style={{ overflow: 'hidden' }}>
        {loading && <div style={{ padding: 28, textAlign: 'center', fontSize: 12.5, color: 'var(--text-3)' }}>Loading…</div>}

        {!loading && items.length === 0 && !error && (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>
            <i className="ti ti-bell-off" style={{ fontSize: 24, display: 'block', margin: '0 auto 10px', color: 'var(--text-4)' }} />
            {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
          </div>
        )}

        {!loading && items.map(n => {
          const href = notificationHref(n)
          return (
            <div key={n.id} style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px',
              background: n.read ? 'transparent' : 'var(--green-lt, #EDFAF2)', borderBottom: '1px solid var(--surface-2)',
            }}>
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 6, flexShrink: 0, background: n.read ? 'transparent' : 'var(--green)' }} />
              <button onClick={() => open(n)}
                style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: href ? 'pointer' : 'default', font: 'inherit' }}>
                <div style={{ fontSize: 13, fontWeight: n.read ? 400 : 600, color: 'var(--text-1)', overflowWrap: 'anywhere' }}>{n.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{n.body}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-4)', marginTop: 5 }}>{timeAgo(n.created_at)}</div>
              </button>
              <button onClick={() => remove(n)} aria-label="Delete notification" title="Delete"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-4)', padding: 4 }}>
                <i className="ti ti-x" style={{ fontSize: 13 }} />
              </button>
            </div>
          )
        })}

        {!loading && hasMore && (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <button className="btn btn-ghost btn-sm" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <span className="spin" /> : 'Load older'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
