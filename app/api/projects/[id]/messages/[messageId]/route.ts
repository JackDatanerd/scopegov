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
import { extractMentions, MESSAGE_MAX_LENGTH } from '@/lib/utils/project-messages'

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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    const { id: projectId, messageId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const text = (body?.body || '').trim()
    if (!text) return NextResponse.json({ error: 'Message body is required' }, { status: 400 })
    if (text.length > MESSAGE_MAX_LENGTH) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })

    const service = createServiceClient()
    const message = await loadMessage(service, session.workspaceId, projectId, messageId)
    if (!message || message.deleted_at) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (message.author_id !== session.id)
      return NextResponse.json({ error: 'Only the author can edit this message' }, { status: 403 })

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

    const { data: members } = await (service as any)
      .from('project_members')
      .select('workspace_members!inner(user_id)')
      .eq('project_id', projectId)
      .eq('workspace_members.workspace_id', session.workspaceId)
    const memberIds = new Set((members || []).map((m: any) => m.workspace_members?.user_id).filter(Boolean))

    const newMentions = extractMentions(text).filter(m => memberIds.has(m.userId))
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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
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
    if (message.author_id !== session.id && !hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Only the author or an admin can delete this message' }, { status: 403 })

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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}
