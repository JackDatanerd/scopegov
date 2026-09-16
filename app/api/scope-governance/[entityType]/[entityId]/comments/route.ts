import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { resolveEntity, canReadProject, canWriteGovernance, isValidEntityType } from '@/lib/utils/flag-governance'
import { notifyMembersWithPermission } from '@/lib/utils/notify'

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

    const body = await request.json()
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
    await notifyEntityOwner(service, session, entityType, entityId, entity.projectId, comment.id)

    return NextResponse.json({
      comment: {
        id: comment.id, body: text, createdAt: comment.created_at,
        authorId: session.id, authorName: session.name, authorAvatarUrl: session.avatarUrl,
      },
    })
  } catch (err) {
    console.error('Flag comments POST error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}

async function notifyEntityOwner(
  service: any,
  session: import('@/lib/supabase/types').SessionUser,
  entityType: 'flag' | 'exception',
  entityId: string,
  projectId: string,
  commentId: string
) {
  try {
    let ownerId: string | null = null
    let title = 'New comment'

    if (entityType === 'flag') {
      const { data: flag } = await service
        .from('guardian_flags')
        .select('resolved_by, escalated_to, sow_reference')
        .eq('id', entityId).single()
      ownerId = flag?.resolved_by || flag?.escalated_to || null
      title = `New comment on scope flag — ${flag?.sow_reference || ''}`

      // FIX (audit round 6): no owner yet (open/borderline, unescalated) —
      // broadcast to whoever could act on it instead of notifying no one.
      if (!ownerId) {
        await notifyMembersWithPermission(service, {
          workspaceId: session.workspaceId, permission: 'APPROVE_FLAGS', eventType: 'flag_comment_added',
          type: 'flag_comment_added', title,
          body: `${session.name} left a comment.`,
          entityType: 'flag', entityId, excludeUserId: session.id, projectId,
        })
        return
      }
    } else {
      const { data: exception } = await service
        .from('exceptions_log')
        .select('granted_by, deliverable')
        .eq('id', entityId).single()
      ownerId = exception?.granted_by || null
      title = `New comment on exception — ${exception?.deliverable || ''}`
    }

    if (!ownerId || ownerId === session.id) return

    // Respect the workspace's notification default / user override for
    // this event type, same as email recipients do elsewhere.
    const { data: pref } = await service
      .from('notification_preferences')
      .select('in_app_enabled')
      .eq('user_id', ownerId).eq('workspace_id', session.workspaceId)
      .eq('event_type', 'flag_comment_added').maybeSingle()
    if (pref && pref.in_app_enabled === false) return

    await service.from('notifications').insert({
      workspace_id: session.workspaceId,
      recipient_id: ownerId,
      type: 'flag_comment_added',
      title,
      body: `${session.name} left a comment.`,
      entity_type: entityType,
      entity_id: entityId,
      // FIX (re-audit, notifications section): entity_type here is
      // 'flag'/'exception', not 'project' — the bell has no href case for
      // those and, even fixed, has nothing to build a project link from
      // without this. See migration 028 and NotificationBell.tsx.
      project_id: projectId,
    })
  } catch {
    // Never let a notification failure break comment creation.
  }
}
