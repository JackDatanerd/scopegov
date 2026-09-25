export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { nanoid } from 'nanoid'
import { checkSeatLimit } from '@/lib/utils/seat-limit'
import { roleWithinCeiling } from '@/lib/utils/permission-ceiling'

// "Copy invite link": hands an admin the invite URL so it can be shared over WhatsApp/Slack when the
// email bounced or landed in spam. A still-live invite returns its EXISTING link (nothing rotates, so
// the emailed link keeps working). An expired invite is re-issued exactly as Resend does — new token,
// new 7-day expiry, this person becomes the inviter of record — just without sending an email.
//
// The link is a bearer credential for the invited seat, so this is held to the same bar as Resend:
// INVITE_MEMBERS, the role must be within the caller's own ceiling, and every use is audit-logged.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'INVITE_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission: INVITE_MEMBERS' }, { status: 403 })

    const service = createServiceClient() as any
    const { data: member } = await service
      .from('workspace_members')
      .select('id,status,invited_email,invite_token,invite_token_expires_at,roles(name,permissions),users!workspace_members_user_id_fkey(email)')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()

    if (!member) return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
    if (member.status !== 'invited' && member.status !== 'expired')
      return NextResponse.json({ error: 'There is no pending invite for this member.' }, { status: 409 })
    if (member.roles && !roleWithinCeiling(session, member.roles))
      return NextResponse.json({ error: 'Cannot share an invite for a role with permissions you don\u2019t hold yourself' }, { status: 403 })

    const email = member.invited_email || member.users?.email
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    if (!appUrl) return NextResponse.json({ error: 'The app URL is not configured, so an invite link can\u2019t be built.' }, { status: 500 })

    const stillLive = member.status === 'invited' && !!member.invite_token && !!member.invite_token_expires_at
      && new Date(member.invite_token_expires_at).getTime() > Date.now()

    let token: string = member.invite_token
    let expiresAt: string = member.invite_token_expires_at
    let reissued = false

    if (!stillLive) {
      // Same rule as Resend: an expired invite no longer holds a seat, so bringing it back must pass the seat check.
      const seatCheck = await checkSeatLimit(service, session.workspaceId, session.planTier, ['active', 'invited'])
      if (!seatCheck.ok)
        return NextResponse.json({ error: seatCheck.message, upgradeRequired: true }, { status: 403 })

      token = nanoid(32)
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      // FIX (independent re-audit, Team & Invites section — same race as
      // Resend, see that route's own fix note): this reissue and Resend's
      // reissue both rotate the same invite_token column with no coordination
      // between them. Two admins clicking Copy link and Resend on the same
      // expired invite within the same moment could otherwise have this
      // write silently clobber Resend's just-emailed token (or vice versa),
      // leaving whichever one "lost" pointing the recipient at a dead link
      // with no error shown to either admin. Compare-and-swap on the exact
      // token this request read.
      let updateQuery = service.from('workspace_members').update({
        invite_token: token, invite_token_expires_at: expiresAt, status: 'invited', invited_by: session.id,
      }).eq('id', id).eq('workspace_id', session.workspaceId).in('status', ['invited', 'expired'])
      if (member.invite_token) updateQuery = updateQuery.eq('invite_token', member.invite_token)
      const { data: updatedRows, error: updateErr } = await updateQuery.select('id')
      if (updateErr) {
        console.error('Invite link re-issue failed:', updateErr)
        return NextResponse.json({ error: 'Could not create an invite link. Try again.' }, { status: 500 })
      }
      if (!updatedRows || updatedRows.length === 0) {
        return NextResponse.json({
          error: 'This invite was just changed by someone else \u2014 possibly resent or accepted a moment ago. Refresh the Team page to see its current state before trying again.',
        }, { status: 409 })
      }
      reissued = true
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'member.invite_link_copied', entityType: 'workspace_member',
      entityId: id, entityName: email || '',
      metadata: { reissued },
    })

    return NextResponse.json({ ok: true, inviteUrl: `${appUrl}/invite/${token}`, expiresAt, reissued })
  } catch (err) {
    console.error('Invite link error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
