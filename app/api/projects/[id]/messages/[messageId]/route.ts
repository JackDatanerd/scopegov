// app/api/projects/[id]/messages/[messageId]/route.ts
//
// Edit/delete a single message. Author-only for edits; author OR a
// workspace admin (MANAGE_WORKSPACE_SETTINGS) for deletes — the same
// "requester or admin" shape already used for cancelling an approval
// request (app/api/approvals/[id]/cancel/route.ts), so moderation of a
// stray/inappropriate message doesn't require reaching for a database
// console.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import {
  extractMentions, MESSAGE_MAX_LENGTH,
  filterMentionsToProjectMembers, notifyMentionedUsers,
} from '@/lib/utils/project-messages'

async function loadMessage(service: any, workspaceId: string, projectId: string, messageId: string) {
  const { data } = await service
    .from('project_messages')
    .select('id, author_id, deleted_at, project_id, workspace_id')
    .eq('id', messageId)
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .single()
  return data
}

async function loadProjectName(service: any, workspaceId: string, projectId: string): Promise<string> {
  const { data } = await service
    .from('projects').select('name').eq('id', projectId).eq('workspace_id', workspaceId).maybeSingle()
  return data?.name || 'a project'
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    const { id: projectId, messageId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null)
    const text = typeof body?.body === 'string' ? body.body.trim() : ''
    if (!text) return NextResponse.json({ error: 'Message body is required' }, { status: 400 })
    if (text.length > MESSAGE_MAX_LENGTH) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })

    const service = createServiceClient()
    const message = await loadMessage(service, session.workspaceId, projectId, messageId)
    if (!message || message.deleted_at) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (message.author_id !== session.id)
      return NextResponse.json({ error: 'Only the author can edit this message' }, { status: 403 })
    // Authorship isn't enough: someone removed from the project must not be able
    // to keep editing (and @mention-notifying people through) its discussion.
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const now = new Date().toISOString()
    const { error } = await (service as any)
      .from('project_messages')
      .update({ body: text, edited_at: now })
      .eq('id', messageId)

    if (error) throw new Error(error.message)

    // Re-derive mentions from the edited body — a mention added on edit
    // still notifies (the person genuinely wasn't told before); a mention
    // removed on edit is deleted so the mentions table reflects what's
    // actually in the message. No new notification for edits, only for
    // net-new mentions the first POST couldn't have known about.
    const { data: existing } = await (service as any)
      .from('project_message_mentions')
      .select('user_id')
      .eq('message_id', messageId)
    const existingIds = new Set<string>((existing || []).map((r: any) => r.user_id))

    const rawMentions = extractMentions(text)
    const newMentions = rawMentions.length
      ? await filterMentionsToProjectMembers(service, session.workspaceId, projectId, rawMentions)
      : []
    const newIds = new Set(newMentions.map(m => m.userId))

    const toRemove = Array.from(existingIds).filter(id => !newIds.has(id))
    const toAdd = newMentions.filter(m => !existingIds.has(m.userId))

    if (toRemove.length) {
      await (service as any).from('project_message_mentions')
        .delete().eq('message_id', messageId).in('user_id', toRemove)
    }
    if (toAdd.length) {
      await (service as any).from('project_message_mentions')
        .insert(toAdd.map(m => ({ message_id: messageId, user_id: m.userId })))
      // FIX (deep audit, section 7): this comment always said net-new
      // mentions on an edit should notify — but nothing ever called the
      // notifier here, so someone freshly @mentioned by an edit (not the
      // original post) was silently never told. notifyMentionedUsers
      // already no-ops safely on failure and skips the editor themselves.
      const projectName = await loadProjectName(service, session.workspaceId, projectId)
      await notifyMentionedUsers(service, session, projectId, projectName, text, toAdd)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project_message.edited', entityType: 'project_message',
      entityId: messageId, metadata: { project_id: projectId },
    })

    return NextResponse.json({ message: { id: messageId, body: text, editedAt: now } })
  } catch (err) {
    console.error('Project message PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    const { id: projectId, messageId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const message = await loadMessage(service, session.workspaceId, projectId, messageId)
    if (!message || message.deleted_at) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const isAuthor = message.author_id === session.id
    const isAdmin  = hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')
    if (!isAuthor && !isAdmin)
      return NextResponse.json({ error: 'Only the author or an admin can delete this message' }, { status: 403 })
    // FIX (Projects & Dashboard deep audit): PATCH already requires this —
    // "someone removed from the project must not be able to keep editing
    // its discussion" — but DELETE never applied the same reasoning to its
    // author branch. An admin deleting via MANAGE_WORKSPACE_SETTINGS is a
    // moderation override and doesn't need project visibility; an author
    // acting purely on authorship does, same as PATCH.
    if (isAuthor && !isAdmin && !(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const now = new Date().toISOString()
    const { error } = await (service as any)
      .from('project_messages')
      .update({ deleted_at: now })
      .eq('id', messageId)

    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'project_message.deleted', entityType: 'project_message',
      entityId: messageId, metadata: { project_id: projectId, by_admin: message.author_id !== session.id },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Project message DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
