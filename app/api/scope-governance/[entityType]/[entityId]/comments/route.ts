import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { resolveEntity, canReadProject, canWriteGovernance, isValidEntityType } from '@/lib/utils/flag-governance'
import { notifyUsers } from '@/lib/utils/notify'
import { getMembersWithPermission } from '@/lib/utils/permissions-query'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ entityType: string; entityId: string }> }
) {
  try {
    const { entityType, entityId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isValidEntityType(entityType))
      return NextResponse.json({ error: 'Invalid entity type' }, { status: 400 })

    const service = createServiceClient()
    const entity = await resolveEntity(service, session.workspaceId, entityType, entityId)
    if (!entity) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, entity.projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: comments } = await (service as any)
      .from('flag_comments')
      .select('id, body, created_at, author_id, users!flag_comments_author_id_fkey(name, avatar_url)')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: true })

    return NextResponse.json({
      comments: (comments || []).map((c: any) => ({
        id: c.id,
        body: c.body,
        createdAt: c.created_at,
        authorId: c.author_id,
        authorName: c.users?.name || 'Unknown',
        authorAvatarUrl: c.users?.avatar_url || null,
      })),
    })
  } catch (err) {
    console.error('Flag comments GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ entityType: string; entityId: string }> }
) {
  try {
    const { entityType, entityId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isValidEntityType(entityType))
      return NextResponse.json({ error: 'Invalid entity type' }, { status: 400 })
    if (!canWriteGovernance(session))
      return NextResponse.json({ error: 'Missing permission: APPROVE_FLAGS or GRANT_EXCEPTIONS' }, { status: 403 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    // A non-string body (number/array/object) used to throw on `.trim()` → 500.
    if (body?.body !== undefined && typeof body.body !== 'string')
      return NextResponse.json({ error: 'Comment body must be text' }, { status: 400 })
    const text = (body?.body || '').trim()
    if (!text) return NextResponse.json({ error: 'Comment body is required' }, { status: 400 })
    if (text.length > 4000) return NextResponse.json({ error: 'Comment is too long' }, { status: 400 })

    const service = createServiceClient()
    const entity = await resolveEntity(service, session.workspaceId, entityType, entityId)
    if (!entity) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, entity.projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: comment, error } = await (service as any)
      .from('flag_comments')
      .insert({
        workspace_id: session.workspaceId,
        project_id: entity.projectId,
        entity_type: entityType,
        entity_id: entityId,
        body: text,
        author_id: session.id,
      })
      .select('id, created_at')
      .single()

    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'flag_comment.added',
      entityType: entityType === 'flag' ? 'guardian_flag' : 'exception',
      entityId, metadata: { comment_id: comment.id },
    })

    // FIX (independent pass, section 13): comments didn't touch the flag's updated_at, so
    // cron/guardian-flag-stall (which measures inactivity by updated_at) kept sending
    // "this flag has been open X days" reminders on flags that were being actively discussed.
    if (entityType === 'flag') {
      const { error: touchErr } = await (service as any).from('guardian_flags')
        .update({ updated_at: new Date().toISOString() }).eq('id', entityId)
      if (touchErr) console.error('Could not bump flag activity timestamp:', touchErr.message)
    }

    // Notify whoever owns this flag/exception (resolved it, is escalated to
    // it, or granted the exception) — not a broadcast to every permitted
    // member. Skip notifying the commenter about their own comment.
    //
    // FIX (audit round 6): a brand-new, still-open, unescalated flag has
    // neither resolved_by nor escalated_to — which is the most common
    // state for a flag to actually be discussed in (before anyone has
    // resolved or escalated it). notifyEntityOwner silently no-op'd for
    // exactly that case, so comments on active, undecided flags reached
    // nobody. Fall back to the same APPROVE_FLAGS broadcast used when the
    // flag was first raised.
    await notifyEntityOwner(service, session, entityType, entityId, entity.projectId, comment.id, text)

    return NextResponse.json({
      comment: {
        id: comment.id, body: text, createdAt: comment.created_at,
        authorId: session.id, authorName: session.name, authorAvatarUrl: session.avatarUrl,
      },
    })
  } catch (err) {
    console.error('Flag comments POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function notifyEntityOwner(
  service: any,
  session: import('@/lib/supabase/types').SessionUser,
  entityType: 'flag' | 'exception',
  entityId: string,
  projectId: string,
  commentId: string,
  commentText: string
) {
  try {
    // FIX (independent pass, section 13): a flag escalated to one person and then resolved by another
    // only notified the resolver (`resolved_by || escalated_to`) — the escalatee never heard about the
    // discussion. Both are owners now.
    let ownerIds: string[] = []
    let title = 'New comment'

    if (entityType === 'flag') {
      const { data: flag } = await service
        .from('guardian_flags')
        .select('resolved_by, escalated_to, sow_reference')
        .eq('id', entityId).single()
      ownerIds = [flag?.resolved_by, flag?.escalated_to].filter((v: any): v is string => !!v)
      // No trailing " — " when the flag cites no SOW reference.
      title = `New comment on scope flag${flag?.sow_reference ? ` — ${flag.sow_reference}` : ''}`
    } else {
      const { data: exception } = await service
        .from('exceptions_log')
        .select('granted_by, deliverable')
        .eq('id', entityId).single()
      ownerIds = exception?.granted_by ? [exception.granted_by] : []
      title = `New comment on exception${exception?.deliverable ? ` — ${exception.deliverable}` : ''}`
    }

    // Who hears about a comment:
    //  • the owner (resolver / escalatee / grantor) — or, for a brand-new undecided flag with no owner
    //    yet, everyone who could act on it (audit round 6);
    //  • everyone who has already commented on this thread. Replies used to reach only the owner, so
    //    an owner answering a question left the person who asked it — the previous commenter — unaware.
    const recipientIds = new Set<string>()
    if (ownerIds.length) ownerIds.forEach(o => recipientIds.add(o))
    else if (entityType === 'flag') {
      const actors = await getMembersWithPermission(
        service, session.workspaceId, 'APPROVE_FLAGS', 25, projectId, undefined, 'in_app', session.id
      )
      actors.forEach(a => recipientIds.add(a.id))
    }
    const { data: prior } = await service.from('flag_comments')
      .select('author_id').eq('entity_type', entityType).eq('entity_id', entityId).neq('id', commentId)
    for (const row of prior || []) if (row.author_id) recipientIds.add(row.author_id)
    recipientIds.delete(session.id)
    if (recipientIds.size === 0) return

    // notifyUsers is the single choke point: active membership, project access, the in-app
    // preference / workspace default, and the insert's own error are all handled there.
    const snippet = commentText.length > 140 ? `${commentText.slice(0, 137)}…` : commentText
    await notifyUsers(service, {
      workspaceId: session.workspaceId, recipientIds: Array.from(recipientIds),
      type: 'flag_comment_added', eventType: 'flag_comment_added',
      title, body: `${session.name}: ${snippet}`,
      entityType, entityId, projectId, excludeUserId: session.id,
    })
  } catch {
    // Never let a notification failure break comment creation.
  }
}
