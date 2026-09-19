export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendInviteEmail } from '@/lib/email/templates'
import { nanoid } from 'nanoid'
import { roleWithinCeiling } from '@/lib/utils/permission-ceiling'
import { checkInviteRateLimit } from '@/lib/utils/rate-limit'
import { checkSeatLimit } from '@/lib/utils/seat-limit'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'INVITE_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission: INVITE_MEMBERS' }, { status: 403 })

    const service = createServiceClient()

    // FIX (deep audit, Team & Invites re-pass — feature gap): see
    // lib/utils/rate-limit.ts's own comment on checkInviteRateLimit for
    // the full story — no backstop existed here at all despite this
    // route sending real email to an arbitrary address.
    const limited = await checkInviteRateLimit(service, session.workspaceId)
    if (!limited.allowed)
      return NextResponse.json({ error: limited.message }, { status: 429 })

    // FIX (audit round 2): workspaceId used to be taken from the request
    // body (`workspaceId || session.workspaceId`), which meant the
    // INVITE_MEMBERS check above only proved the caller could invite into
    // THEIR OWN workspace, while every subsequent check and the insert
    // itself ran against whatever workspace id the client sent — a
    // classic confused-deputy bug letting any admin of any workspace
    // invite arbitrary emails into ANY other workspace by id. There is no
    // legitimate cross-workspace invite flow (compare
    // app/api/workspace/switch/route.ts, which explicitly re-verifies
    // membership before trusting a client-supplied workspace id) — always
    // use the caller's own active workspace.
    const { email, roleId } = await request.json()
    const wsId = session.workspaceId
    // FIX (deep audit, Team & Invites section): `!email?.trim()` was the
    // ONLY check — `.trim()` on a non-string body value threw a TypeError
    // into the catch-all as a 500, and any non-empty string at all
    // created a real workspace_members row and fired a real Resend call.
    // The client's type="email" was the only actual validation in the
    // system, so a typo'd address produced a Pending invite that could
    // never be accepted while still consuming a seat against the
    // ['active','invited'] count until somebody noticed and revoked it.
    if (typeof email !== 'string' || !email.trim())
      return NextResponse.json({ error: 'Email required' }, { status: 400 })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return NextResponse.json({ error: 'That doesn\u2019t look like a valid email address' }, { status: 400 })

    // FIX (audit round 1): roleId came straight from the request body with
    // no check that it actually belongs to this workspace. Low real-world
    // exploitability on its own (role ids are random UUIDs, and `roles`
    // has RLS with no client policies so they can't be enumerated through
    // the DB), but it's a missing check, not a defended one — confirm the
    // role is actually one of this workspace's before it ever reaches the
    // insert below.
    if (roleId) {
      const { data: role } = await (service as any)
        .from('roles').select('id,permissions').eq('id', roleId).eq('workspace_id', wsId).maybeSingle()
      if (!role) return NextResponse.json({ error: 'Invalid role for this workspace' }, { status: 400 })
      // FIX (audit round 4, finding #1): an INVITE_MEMBERS holder without
      // MANAGE_ROLES could still hand a brand-new member the workspace's
      // most-privileged role. Same ceiling rule as everywhere else — can
      // only assign a role whose permissions you already hold yourself.
      if (!roleWithinCeiling(session, role))
        return NextResponse.json({ error: 'Cannot invite someone into a role with permissions you don\u2019t hold yourself' }, { status: 403 })
    }

    // Seat limit check — reserves a seat for a pending invite too, not
    // just active members, so an admin can't invite more people than the
    // plan has room for even before anyone accepts. See
    // lib/utils/seat-limit.ts for why this now lives in one shared place.
    const seatCheck = await checkSeatLimit(service, wsId, session.planTier, ['active', 'invited'])
    if (!seatCheck.ok)
      return NextResponse.json({ error: seatCheck.message, upgradeRequired: true }, { status: 403 })

    // Check for existing membership
    const normalizedEmail = email.toLowerCase().trim()
    const { data: existingUser } = await (service as any)
      .from('users').select('id').eq('email', normalizedEmail).maybeSingle()

    if (existingUser) {
      const { data: existingMember } = await (service as any)
        .from('workspace_members')
        .select('id,status')
        .eq('workspace_id', wsId)
        .eq('user_id', existingUser.id)
        .maybeSingle()

      if (existingMember?.status === 'active')
        return NextResponse.json({ error: 'This person is already a member of the workspace' }, { status: 409 })
      if (existingMember?.status === 'invited')
        return NextResponse.json({ error: 'An invite is already pending for this email' }, { status: 409 })
      // FIX (deep audit, Team & Invites section — HIGH): only those two
      // statuses were handled. 'deactivated' and 'expired' fell straight
      // through to the INSERT below and hit
      // `UNIQUE(workspace_id, user_id)` (001, line 106), which rethrew
      // memberErr into the catch-all as a bare 500 "Internal server
      // error". The admin's mental model — "they left, I'll invite them
      // back" — got an unexplained internal error with no hint that
      // Reactivate is the path, and no hint that anything was wrong with
      // the request rather than with the server.
      //
      // Migration 020's comment already worked through this exact
      // reasoning for the NO-ACCOUNT branch below (which is why
      // workspace_members_pending_email is scoped WHERE status =
      // 'invited'); the existing-user branch was never brought in line.
      if (existingMember?.status === 'deactivated')
        return NextResponse.json({
          error: 'This person was deactivated in this workspace. Reactivate them from the Deactivated list instead of sending a new invite — that restores the access their role already had.',
          reactivateMemberId: existingMember.id,
        }, { status: 409 })
      if (existingMember?.status === 'expired')
        return NextResponse.json({
          error: 'This person already has an expired invite in this workspace. Use Resend on that invite instead of creating a new one.',
          resendMemberId: existingMember.id,
        }, { status: 409 })
    } else {
      // No account yet — check for a duplicate pending invite by email
      // (DB also enforces this via workspace_members_pending_email, this
      // just gives a clean error message instead of a raw constraint error)
      const { data: priorInvite } = await (service as any)
        .from('workspace_members')
        .select('id,status')
        .eq('workspace_id', wsId)
        .eq('invited_email', normalizedEmail)
        .in('status', ['invited', 'expired'])
        .maybeSingle()

      if (priorInvite?.status === 'invited')
        return NextResponse.json({ error: 'An invite is already pending for this email' }, { status: 409 })

      // FIX (deep audit, Team & Invites section): an 'expired' row for the
      // same address is NOT caught by workspace_members_pending_email
      // (that partial index is scoped WHERE status = 'invited'), so a
      // re-invite used to insert a SECOND row alongside the dead one —
      // leaving a permanent phantom entry in the Expired list that no
      // longer corresponds to anything, for an address that now also has
      // a live invite. An expired, never-accepted invite has no user and
      // nothing to preserve; clear it, exactly as DELETE already
      // hard-deletes rows in this state.
      if (priorInvite?.status === 'expired') {
        await (service as any).from('workspace_members').delete().eq('id', priorInvite.id)
      }
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
    // FIX (deep audit, Team & Invites re-pass): a failed send used to be
    // swallowed here with only a console.error — the invite row was
    // already created, so the caller got back `ok: true` with no signal
    // that the email never went out. It would sit as "Pending" forever,
    // discoverable only if the invitee eventually asked about it. Track
    // the outcome and report it.
    let emailSent = true
    try {
      await sendInviteEmail({
        to:            normalizedEmail,
        inviterName:   session.name,
        workspaceName: ws?.name || session.agencyName,
        agencyName:    session.agencyName,
        inviteUrl,
        expiresAt:     expiresAt.toISOString(),
      })
    } catch (e) { console.error('Invite email failed:', e); emailSent = false }

    // FIX (deep audit, Team & Invites re-pass): this used to log the raw
    // invite token/URL verbatim — a live, unexpired credential sitting in
    // a log that's exportable to CSV/PDF and readable by anyone holding
    // VIEW_AUDIT_LOG alone (independent of INVITE_MEMBERS under the
    // custom-role model). Same principle already applied to the agency
    // signature elsewhere in Settings: a bearer credential isn't
    // something an audit row should carry. The invited email address
    // (already the entityName) is enough context for the trail.
    await logAudit(service, {
      workspaceId: wsId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'member.invited', entityType: 'workspace_member',
      entityId: member.id, entityName: normalizedEmail,
      metadata: emailSent ? {} : { email_send_failed: true },
    })

    return NextResponse.json({
      ok: true, memberId: member.id,
      ...(emailSent ? {} : { emailFailed: true }),
    })
  } catch (err) {
    // FIX (deep audit, Team & Invites re-pass): raw exception messages
    // (including memberErr.message re-thrown above) were returned
    // straight to the client — same info-disclosure pattern already
    // fixed elsewhere in this section. Log server-side only.
    console.error('Team invite POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
