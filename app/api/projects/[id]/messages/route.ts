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
import { extractMentions, mentionsToPlainText, MESSAGE_MAX_LENGTH } from '@/lib/utils/project-messages'

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

    const { data: rows } = await (service as any)
      .from('project_messages')
      .select(`
        id, body, created_at, edited_at, deleted_at, author_id,
        users!project_messages_author_id_fkey(name, avatar_url)
      `)
      .eq('project_id', projectId)
      .order('created_at', { ascending: true })
      .limit(FEED_LIMIT)

    const { data: readRow } = await (service as any)
      .from('project_message_reads')
      .select('last_read_at')
      .eq('project_id', projectId)
      .eq('user_id', session.id)
      .maybeSingle()

    const messages = (rows || []).map((m: any) => ({
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
    }))

    return NextResponse.json({ messages, lastReadAt: readRow?.last_read_at || null })
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

    const body = await request.json()
    const text = (body?.body || '').trim()
    if (!text) return NextResponse.json({ error: 'Message body is required' }, { status: 400 })
    if (text.length > MESSAGE_MAX_LENGTH) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })

    const service = createServiceClient()
    const project = await loadProject(service, session.workspaceId, projectId)
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Mentions are extracted from the body itself (see project-messages.ts)
    // rather than a client-supplied id list, then validated against who
    // can actually see this project — mentioning someone outside the
    // project shouldn't silently notify a stranger, and shouldn't error
    // the whole post either (the token was probably stale — e.g. the
    // person was removed from the project between typing and sending).
    const rawMentions = extractMentions(text)
    const validMentions = rawMentions.length
      ? await filterMentionsToProjectMembers(service, session.workspaceId, projectId, rawMentions)
      : []

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

    await notifyMentioned(service, session, projectId, project.name, text, validMentions)

    return NextResponse.json({
      message: {
        id: message.id, body: text, deleted: false, createdAt: message.created_at, editedAt: null,
        authorId: session.id, authorName: session.name, authorAvatarUrl: session.avatarUrl, isMine: true,
      },
    })
  } catch (err) {
    console.error('Project messages POST error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}

async function filterMentionsToProjectMembers(
  service: any,
  workspaceId: string,
  projectId: string,
  mentions: { userId: string; displayName: string }[]
) {
  const { data: members } = await (service as any)
    .from('project_members')
    .select('workspace_members!inner(user_id)')
    .eq('project_id', projectId)
    .eq('workspace_members.workspace_id', workspaceId)

  const memberIds = new Set(
    (members || []).map((m: any) => m.workspace_members?.user_id).filter(Boolean)
  )
  return mentions.filter(m => memberIds.has(m.userId))
}

async function notifyMentioned(
  service: any,
  session: import('@/lib/supabase/types').SessionUser,
  projectId: string,
  projectName: string,
  rawBody: string,
  mentions: { userId: string; displayName: string }[]
) {
  const recipients = mentions.filter(m => m.userId !== session.id)
  if (!recipients.length) return

  try {
    const { data: prefs } = await (service as any)
      .from('notification_preferences')
      .select('user_id, in_app_enabled')
      .eq('workspace_id', session.workspaceId)
      .eq('event_type', 'project_message_mention')
      .in('user_id', recipients.map(r => r.userId))

    const suppressed = new Set(
      (prefs || []).filter((p: any) => p.in_app_enabled === false).map((p: any) => p.user_id)
    )

    const plain = mentionsToPlainText(rawBody)
    const snippet = plain.length > 120 ? `${plain.slice(0, 117)}…` : plain

    // entity_id points at the project (not the message) — NotificationBell
    // only has entity_type/entity_id to build a link from (no metadata
    // column on notifications), and "open the project's Discussion tab"
    // is a perfectly good destination for a mention notification.
    const rows = recipients
      .filter(r => !suppressed.has(r.userId))
      .map(r => ({
        workspace_id: session.workspaceId,
        recipient_id: r.userId,
        type: 'project_message_mention',
        title: `${session.name} mentioned you in ${projectName}`,
        body: snippet,
        entity_type: 'project_message',
        entity_id: projectId,
      }))

    if (rows.length) await (service as any).from('notifications').insert(rows)
  } catch {
    // Never let a notification failure break message creation.
  }
}
