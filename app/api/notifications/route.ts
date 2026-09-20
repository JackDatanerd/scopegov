export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { parseIds, parseCursor, MAX_IDS } from '@/lib/utils/notification-input'

// Notifications & email fix round — what changed here and why:
//
//  GET
//   • Errors were never read: a failed query returned `{ notifications: [], unreadCount: 0 }`
//     with a 200, which the bell rendered as "No notifications yet". A failure is now a 500.
//   • It could only ever return the latest 50 rows — anything older was unreachable. It now
//     pages with a keyset cursor (created_at, id), optionally filtered to unread, so the
//     inbox page can walk the whole history.
//  PATCH
//   • The update's `{ error }` was never read (supabase-js returns it, it doesn't throw), so
//     the route answered `ok` for a failed write — including any request whose ids were not
//     valid uuids, which Postgres rejects.
//   • "Mark all read" had no `read = false` guard, so it rewrote read_at on every notification
//     the user had ever read (destroying when they actually read it) and touched every row.
//   • ids were not validated or bounded, and a malformed body was a 500.
//  DELETE (new)
//   • Notifications could never be removed and nothing purged them either (see
//     app/api/cron/notification-cleanup), so the table only ever grew.

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const sp = new URL(request.url).searchParams
    const limit = Math.min(Math.max(parseInt(sp.get('limit') || '', 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    const unreadOnly = sp.get('unread') === '1'
    const rawCursor = sp.get('cursor')
    const cursor = parseCursor(rawCursor)
    if (rawCursor && !cursor) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })

    const service = createServiceClient() as any

    let q = service
      .from('notifications')
      .select('*')
      .eq('workspace_id', session.workspaceId)
      .eq('recipient_id', session.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1) // one extra row tells us whether another page exists
    if (unreadOnly) q = q.eq('read', false)
    if (cursor) q = q.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)

    const [{ data: rows, error }, { count, error: countError }] = await Promise.all([
      q,
      service
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId)
        .eq('recipient_id', session.id)
        .eq('read', false),
    ])
    if (error || countError) {
      console.error('Notifications GET failed:', error?.message || countError?.message)
      return NextResponse.json({ error: 'Could not load notifications' }, { status: 500 })
    }

    const page = (rows || []).slice(0, limit)
    const hasMore = (rows || []).length > limit
    const last = page[page.length - 1]
    return NextResponse.json({
      notifications: page,
      unreadCount: count || 0,
      hasMore,
      nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null,
    })
  } catch (err) {
    console.error('Notifications GET error:', err)
    return NextResponse.json({ error: 'Could not load notifications' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object')
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const { ids, all } = body as { ids?: unknown; all?: unknown }

    const idList = all === true ? null : parseIds(ids)
    if (all !== true && !idList)
      return NextResponse.json({ error: `Provide 1–${MAX_IDS} valid notification ids, or all: true` }, { status: 400 })

    const service = createServiceClient() as any
    let q = service.from('notifications')
      .update({ read: true, read_at: new Date().toISOString() })
      .eq('workspace_id', session.workspaceId)
      .eq('recipient_id', session.id)
      // Only rows that are actually unread: keeps the original read_at and avoids
      // rewriting the user's whole history on every "mark all read".
      .eq('read', false)
    if (idList) q = q.in('id', idList)

    const { data, error } = await q.select('id')
    if (error) {
      console.error('Notifications PATCH failed:', error.message)
      return NextResponse.json({ error: 'Could not update notifications' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, updated: (data || []).length })
  } catch (err) {
    console.error('Notifications PATCH error:', err)
    return NextResponse.json({ error: 'Could not update notifications' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object')
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const { ids, allRead } = body as { ids?: unknown; allRead?: unknown }

    const idList = allRead === true ? null : parseIds(ids)
    if (allRead !== true && !idList)
      return NextResponse.json({ error: `Provide 1–${MAX_IDS} valid notification ids, or allRead: true` }, { status: 400 })

    const service = createServiceClient() as any
    let q = service.from('notifications')
      .delete()
      .eq('workspace_id', session.workspaceId)
      .eq('recipient_id', session.id)
    // "Clear read" never removes anything the user hasn't seen.
    if (allRead === true) q = q.eq('read', true)
    if (idList) q = q.in('id', idList)

    const { data, error } = await q.select('id')
    if (error) {
      console.error('Notifications DELETE failed:', error.message)
      return NextResponse.json({ error: 'Could not delete notifications' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, deleted: (data || []).length })
  } catch (err) {
    console.error('Notifications DELETE error:', err)
    return NextResponse.json({ error: 'Could not delete notifications' }, { status: 500 })
  }
}
