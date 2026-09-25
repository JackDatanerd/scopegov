// app/api/projects/[id]/messages/route.ts
//
// Project Discussion — a general per-project message feed, open to
// anyone who can already see the project (see lib/utils/project-access.ts).
// Deliberately no separate write permission: unlike flag_comments (a
// governance action gated behind APPROVE_FLAGS/GRANT_EXCEPTIONS), this is
// ordinary team collaboration — if you're on the project, you can talk
// about it.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { MESSAGE_MAX_LENGTH, resolveMentions, notifyMentionedUsers } from '@/lib/utils/project-messages'

// Recent-history cap for the feed. This is a live discussion thread, not
// an archive — a "load older" affordance can be added later if agencies
// actually run projects long enough to need it, but nothing so far in
// this codebase paginates a comment feed either (flag_comments doesn't).
const FEED_LIMIT = 200

async function loadProject(service: any, workspaceId: string, projectId: string) {
  const { data } = await service
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .single()
  return data
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const project = await loadProject(service, session.workspaceId, projectId)
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Projects & Dashboard deep audit: this used to be
    // `order created_at ASC limit 200`, which returns the OLDEST 200 messages.
    // Once a project had 200 messages (deleted placeholders included) every
    // new message was saved but never shown again after a reload, while the
    // unread badge kept counting it. The default page is now the NEWEST
    // FEED_LIMIT messages; `before` pages backwards ("load earlier") and
    // `after` fetches only what arrived since the newest loaded message
    // (used for polling).
    const url = new URL(request.url)
    const beforeRaw = url.searchParams.get('before')
    const afterRaw = url.searchParams.get('after')
    const changedSinceRaw = url.searchParams.get('changedSince')
    const validTs = (v: string | null) => v !== null && !Number.isNaN(new Date(v).getTime())
    if ((beforeRaw && !validTs(beforeRaw)) || (afterRaw && !validTs(afterRaw)) || (changedSinceRaw && !validTs(changedSinceRaw)))
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    // Taken BEFORE the queries run: the client passes it back as changedSince next poll, so a change that
    // lands while this request is executing is picked up next time instead of falling in a gap.
    const syncedAt = new Date().toISOString()

    let feed = (service as any)
      .from('project_messages')
      .select(`
        id, body, created_at, edited_at, deleted_at, author_id,
        users!project_messages_author_id_fkey(name, avatar_url)
      `)
      .eq('project_id', projectId)

    let rows: any[]
    let hasMore = false
    if (afterRaw) {
      const { data, error } = await feed.gt('created_at', afterRaw)
        .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(FEED_LIMIT)
      if (error) throw new Error(error.message)
      rows = data || []
    } else {
      if (beforeRaw) feed = feed.lt('created_at', beforeRaw)
      const { data, error } = await feed
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(FEED_LIMIT + 1)
      if (error) throw new Error(error.message)
      const desc: any[] = data || []
      hasMore = desc.length > FEED_LIMIT
      rows = desc.slice(0, FEED_LIMIT).reverse()
    }

    const { data: readRow } = await (service as any)
      .from('project_message_reads')
      .select('last_read_at')
      .eq('project_id', projectId)
      .eq('user_id', session.id)
      .maybeSingle()

    const shape = (m: any) => ({
      id: m.id,
      // Deleted messages keep their row (mentions/audit still reference
      // it) but the client only ever sees a tombstone, never the body.
      body: m.deleted_at ? null : m.body,
      deleted: !!m.deleted_at,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      authorId: m.author_id,
      authorName: m.users?.name || 'Unknown',
      authorAvatarUrl: m.users?.avatar_url || null,
      isMine: m.author_id === session.id,
    })
    const messages = rows.map(shape)

    // Polling used to fetch only NEW messages (created_at > after), so an edit or delete made by someone
    // else stayed invisible on every other open screen until a full reload — including a moderator
    // removing a message. `changedSince` returns rows edited or deleted since the last poll.
    let changed: ReturnType<typeof shape>[] = []
    if (afterRaw && changedSinceRaw) {
      const since = new Date(changedSinceRaw).toISOString() // re-serialised: only safe characters reach the filter
      const { data: changedRows, error: changedErr } = await (service as any)
        .from('project_messages')
        .select(`id, body, created_at, edited_at, deleted_at, author_id, users!project_messages_author_id_fkey(name, avatar_url)`)
        .eq('project_id', projectId)
        .or(`edited_at.gt.${since},deleted_at.gt.${since}`)
        .order('created_at', { ascending: true }).limit(100)
      if (changedErr) throw new Error(changedErr.message)
      const returned = new Set(messages.map(m => m.id))
      changed = (changedRows || []).filter((m: any) => !returned.has(m.id)).map(shape)
    }

    return NextResponse.json({ messages, changed, syncedAt, hasMore, lastReadAt: readRow?.last_read_at || null })
  } catch (err) {
    console.error('Project messages GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null)
    const typed = typeof body?.body === 'string' ? body.body.trim() : ''
    if (!typed) return NextResponse.json({ error: 'Message body is required' }, { status: 400 })
    if (typed.length > MESSAGE_MAX_LENGTH) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })

    const service = createServiceClient()
    const project = await loadProject(service, session.workspaceId, projectId)
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Mentions are read from the body itself (see project-messages.ts), validated against who can
    // actually see this project (its team plus everyone with VIEW_ALL_PROJECTS), and the body is stored in
    // canonical form: real names inside tokens, stale tokens degraded to plain "@Name" text.
    const resolved = await resolveMentions(service, session.workspaceId, projectId, typed)
    const text = resolved.body
    const validMentions = resolved.mentions
    if (text.length > MESSAGE_MAX_LENGTH) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })

    const { data: message, error } = await (service as any)
      .from('project_messages')
      .insert({
        workspace_id: session.workspaceId,
        project_id: projectId,
        author_id: session.id,
        body: text,
      })
      .select('id, created_at')
      .single()

    if (error) throw new Error(error.message)

    if (validMentions.length) {
      await (service as any).from('project_message_mentions').insert(
        validMentions.map(m => ({ message_id: message.id, user_id: m.userId }))
      )
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project_message.added', entityType: 'project_message',
      entityId: message.id, entityName: project.name,
      metadata: { project_id: projectId, mention_count: validMentions.length },
    })

    await notifyMentionedUsers(service, session, projectId, project.name, text, validMentions)

    return NextResponse.json({
      message: {
        id: message.id, body: text, deleted: false, createdAt: message.created_at, editedAt: null,
        authorId: session.id, authorName: session.name, authorAvatarUrl: session.avatarUrl, isMine: true,
      },
    })
  } catch (err) {
    console.error('Project messages POST error:', err)
    return NextResponse.json({ error: 'Could not post the message' }, { status: 500 })
  }
}

