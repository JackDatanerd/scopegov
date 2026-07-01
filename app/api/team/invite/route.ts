export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendInviteEmail } from '@/lib/email/templates'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { nanoid } from 'nanoid'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'INVITE_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission: INVITE_MEMBERS' }, { status: 403 })

    const { email, roleId, workspaceId } = await request.json()
    const wsId = workspaceId || session.workspaceId
    if (!email?.trim()) return NextResponse.json({ error: 'Email required' }, { status: 400 })

    const service = createServiceClient()

    // Seat limit check
    const limits = PLAN_LIMITS[session.planTier]
    if (limits?.seats) {
      const { count } = await (service as any)
        .from('workspace_members')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', wsId)
        .in('status', ['active', 'invited'])
      if ((count || 0) >= limits.seats)
        return NextResponse.json({
          error: `Seat limit reached (${limits.seats} seats on ${session.planTier} plan). Upgrade to invite more members.`,
          upgradeRequired: true,
        }, { status: 403 })
    }

    // Check for existing membership
    const normalizedEmail = email.toLowerCase().trim()
    const { data: existingUser } = await (service as any)
      .from('users').select('id').eq('email', normalizedEmail).single()

    if (existingUser) {
      const { data: existingMember } = await (service as any)
        .from('workspace_members')
        .select('id,status')
        .eq('workspace_id', wsId)
        .eq('user_id', existingUser.id)
        .single()

      if (existingMember?.status === 'active')
        return NextResponse.json({ error: 'This person is already a member of the workspace' }, { status: 409 })
      if (existingMember?.status === 'invited')
        return NextResponse.json({ error: 'An invite is already pending for this email' }, { status: 409 })
    } else {
      // No account yet — check for a duplicate pending invite by email
      // (DB also enforces this via workspace_members_pending_email, this
      // just gives a clean error message instead of a raw constraint error)
      const { data: pendingInvite } = await (service as any)
        .from('workspace_members')
        .select('id')
        .eq('workspace_id', wsId)
        .eq('invited_email', normalizedEmail)
        .eq('status', 'invited')
        .single()

      if (pendingInvite)
        return NextResponse.json({ error: 'An invite is already pending for this email' }, { status: 409 })
    }

    const inviteToken   = nanoid(32)
    const expiresAt     = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const { data: member, error: memberErr } = await (service as any)
      .from('workspace_members')
      .insert({
        workspace_id:            wsId,
        user_id:                 existingUser?.id || null,
        invited_email:           normalizedEmail,
        role_id:                 roleId || null,
        effective_permissions:   '{}',
        status:                  'invited',
        invite_token:            inviteToken,
        invite_token_expires_at: expiresAt.toISOString(),
        invited_at:              new Date().toISOString(),
        invited_by:              session.id,
      })
      .select('id').single()

    if (memberErr) throw new Error(memberErr.message)

    // Fetch workspace info for email
    const { data: ws } = await (service as any)
      .from('workspaces').select('name,agency_name').eq('id', wsId).single()

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invite/${inviteToken}`
    try {
      await sendInviteEmail({
        to:            normalizedEmail,
        inviterName:   session.name,
        workspaceName: ws?.name || session.agencyName,
        agencyName:    session.agencyName,
        inviteUrl,
        expiresAt:     expiresAt.toISOString(),
      })
    } catch (e) { console.error('Invite email failed:', e) }

    await logAudit(service, {
      workspaceId: wsId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'member.invited', entityType: 'workspace_member',
      entityId: member.id, entityName: normalizedEmail,
      metadata: { invite_url: inviteUrl },
    })

    return NextResponse.json({ ok: true, memberId: member.id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
