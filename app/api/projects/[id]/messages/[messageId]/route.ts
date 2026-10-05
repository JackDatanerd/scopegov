// app/api/projects/[id]/messages/[messageId]/route.ts
//
// Edit/delete a single message. Author-only for edits; author OR a
// workspace admin (MANAGE_WORKSPACE_SETTINGS) for deletes — the same
// "requester or admin" shape already used for cancelling an approval
// request (app/api/approvals/[id]/cancel/route.ts), so moderation of a
// stray/inappropriate message doesn't require reaching for a database
// console.

import { isUuidString } from '@/lib/utils/uuid'
import { hasUnstorableText, UNSTORABLE_TEXT_ERROR } from '@/lib/utils/client-input'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { canReadProject } from '@/lib/utils/project-access'
import { MESSAGE_MAX_LENGTH, resolveMentions, notifyMentionedUsers } from '@/lib/utils/project-messages'

async function loadMessage(service: any, workspaceId: string, projectId: string, messageId: string) {
  // FIX (Projects & Dashboard pass 10, B1): .single() + ignored `error` made a failed read answer 404 "Not found" for a message that exists.
  const { data, error } = await service
    .from('project_messages')
    .select('id, author_id, deleted_at, project_id, workspace_id')
    .eq('id', messageId)
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(`message lookup failed: ${error.message}`)
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
    if (!isUuidString(projectId) || !isUuidString(messageId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await request.json().catch(() => null)
    const typed = typeof body?.body === 'string' ? body.body.trim() : ''
    if (!typed) return NextResponse.json({ error: 'Message body is required' }, { status: 400 })
    // FIX (section-7 independent pass, B2): NUL / lone surrogates can't be stored — clean 400, not a 500.
    if (hasUnstorableText(typed)) return NextResponse.json({ error: UNSTORABLE_TEXT_ERROR('Message') }, { status: 400 })
    if (typed.length > MESSAGE_MAX_LENGTH) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })

    const service = createServiceClient()
    const message = await loadMessage(service, session.workspaceId, projectId, messageId)
    if (!message || message.deleted_at) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (message.author_id !== session.id)
      return NextResponse.json({ error: 'Only the author can edit this message' }, { status: 403 })
    // Authorship isn't enough: someone removed from the project must not be able
    // to keep editing (and @mention-notifying people through) its discussion.
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Mentions are resolved against who can actually see the project, and the body is rewritten to the
    // canonical form (real names in tokens; stale tokens degrade to plain text) BEFORE it is stored.
    const resolved = await resolveMentions(service, session.workspaceId, projectId, typed)
    const text = resolved.body
    if (text.length > MESSAGE_MAX_LENGTH) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })

    const now = new Date().toISOString()
    // deleted_at guard: a moderator deleting the message between the load above and this write must not
    // have their deletion "edited" back into an updated row.
    const { data: updated, error } = await (service as any)
      .from('project_messages')
      .update({ body: text, edited_at: now })
      .eq('id', messageId).is('deleted_at', null)
      .select('id')

    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Re-derive mentions from the edited body — a mention added on edit
    // still notifies (the person genuinely wasn't told before); a mention
    // removed on edit is deleted so the mentions table reflects what's
    // actually in the message. No new notification for edits, only for
    // net-new mentions the first POST couldn't have known about.
    // FIX (Projects & Dashboard pass 10, B1): a failed read gave existingIds = {}, so EVERY mention in the edited body counted as new — the insert
    // below then hit UNIQUE(message_id, user_id) on the ones already stored and the whole batch failed, so genuinely new mentions were never
    // saved or notified, and stale ones never removed. The edit itself is already saved, so skip reconciliation (the next edit re-derives it).
    const { data: existing, error: existingErr } = await (service as any)
      .from('project_message_mentions')
      .select('user_id')
      .eq('message_id', messageId)
    if (existingErr) console.error('Project message PATCH: could not read existing mentions — skipping mention reconciliation (next edit retries):', existingErr)
    const existingIds = new Set<string>((existing || []).map((r: any) => r.user_id))

    const newMentions = resolved.mentions
    const newIds = new Set(newMentions.map(m => m.userId))

    const toRemove = existingErr ? [] : Array.from(existingIds).filter(id => !newIds.has(id))
    const toAdd = existingErr ? [] : newMentions.filter(m => !existingIds.has(m.userId))

    if (toRemove.length) {
      const { error: rmErr } = await (service as any).from('project_message_mentions')
        .delete().eq('message_id', messageId).in('user_id', toRemove)
      if (rmErr) console.error('Project message PATCH: could not remove stale mentions:', rmErr)
    }
    if (toAdd.length) {
      const { error: addErr } = await (service as any).from('project_message_mentions')
        .insert(toAdd.map(m => ({ message_id: messageId, user_id: m.userId })))
      if (addErr) {
        // Not notified without a stored row: the next edit re-derives the same diff and retries, so nobody is told
        // twice and nobody is left permanently unmentioned.
        console.error('Project message PATCH: could not save new mentions (will retry on next edit):', addErr)
      } else {
        const projectName = await loadProjectName(service, session.workspaceId, projectId)
        await notifyMentionedUsers(service, session, projectId, projectName, text, toAdd)
      }
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
    if (!isUuidString(projectId) || !isUuidString(messageId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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
    // FIX (Projects & Dashboard pass 4 — B4): the write had no `deleted_at IS NULL` guard and never looked at how many rows it
    // touched, so two concurrent deletes both "succeeded" and each wrote a project_message.deleted audit row (the second also
    // overwrote the first deleted_at). Only the request that actually flips the row audits.
    const { data: deleted, error } = await (service as any)
      .from('project_messages')
      .update({ deleted_at: now })
      .eq('id', messageId).is('deleted_at', null)
      .select('id')

    if (error) throw new Error(error.message)
    if (!deleted || deleted.length === 0) return NextResponse.json({ ok: true })

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
