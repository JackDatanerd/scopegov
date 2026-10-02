export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendInviteEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { nanoid } from 'nanoid'
import { roleWithinCeiling } from '@/lib/utils/permission-ceiling'
import { checkInviteRateLimit } from '@/lib/utils/rate-limit'
import { checkSeatLimit, seatLimitBreachedAfterWrite } from '@/lib/utils/seat-limit'

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
    const body = await request.json().catch(() => null)
    const email  = body?.email
    const roleId = body?.roleId
    const wsId = session.workspaceId
    // FIX (fresh independent audit, section 4): the onboarding wizard already sends its own
    // workspaceId here, but nothing read it — settings/branding/defaults refuse a mismatch with
    // the session's active workspace (a second tab or device that switched, discarded or restored
    // a workspace mid-wizard), and this route silently invited into whatever was active instead.
    // Optional, so other callers (Team page) that never send it keep working unchanged.
    if (body?.workspaceId !== undefined && body.workspaceId !== wsId)
      return NextResponse.json({
        error: 'You\u2019re no longer working on that workspace. Reload the page and try again.',
      }, { status: 409 })
    if (typeof email !== 'string' || !email.trim())
      return NextResponse.json({ error: 'Email required' }, { status: 400 })
    if (email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return NextResponse.json({ error: 'That doesn\u2019t look like a valid email address' }, { status: 400 })
    if (roleId !== undefined && roleId !== null && roleId !== '' && typeof roleId !== 'string')
      return NextResponse.json({ error: 'Invalid role for this workspace' }, { status: 400 })

    // The role this person will hold. An explicit choice must belong to this
    // workspace; with no choice the workspace default applies. Either way the
    // role is fixed now and must sit within the inviter's own permissions, so
    // nothing the inviter couldn't grant can be handed out later through a
    // default that changes (or was already privileged) before acceptance.
    let role: { id: string; name: string; permissions: Record<string, unknown> } | null = null
    if (roleId) {
      const { data, error: roleErr } = await (service as any)
        .from('roles').select('id,name,permissions').eq('id', roleId).eq('workspace_id', wsId).maybeSingle()
      // A failed read is not "invalid role" (400 blamed the admin's input for a database blip).
      if (roleErr) return NextResponse.json({ error: 'Could not load that role. Please try again.' }, { status: 500 })
      if (!data) return NextResponse.json({ error: 'Invalid role for this workspace' }, { status: 400 })
      role = data
    } else {
      const { data, error: defaultRoleErr } = await (service as any)
        .from('roles').select('id,name,permissions').eq('workspace_id', wsId).eq('is_default', true).maybeSingle()
      // Not "no default role": null here skipped the ceiling check and minted an invite that accept's
      // inviterMayStillGrant() can refuse for the whole 7 days it holds a seat.
      if (defaultRoleErr) return NextResponse.json({ error: 'Could not load the workspace\u2019s default role. Please try again.' }, { status: 500 })
      role = data || null
    }
    if (role && !roleWithinCeiling(session, role)) {
      return NextResponse.json({
        error: roleId
          ? 'Cannot invite someone into a role with permissions you don\u2019t hold yourself'
          : `The workspace\u2019s default role (${role.name}) holds permissions you don\u2019t hold yourself, so you can\u2019t invite without choosing a role. Pick a role you can assign.`,
      }, { status: 403 })
    }

    const normalizedEmail = email.toLowerCase().trim()
    const { data: existingUser, error: existingUserErr } = await (service as any)
      .from('users').select('id, deleted_at').eq('email', normalizedEmail).maybeSingle()
    // Not "no account for this address": that skipped the deleted-account and member-by-account guards below.
    if (existingUserErr) return NextResponse.json({ error: 'Could not check this address. Please try again.' }, { status: 500 })

    // FIX (Team & Invites independent pass — invite to a deleted account): a self-deleted account keeps its
    // email (and is banned) for the 30-day erasure window, so this lookup finds it. The invite was created
    // anyway — with that dead account's user_id — and held a seat for 7 days that nobody could ever use:
    // accept refuses a deleted account (403), and signup can't recreate the address while the banned auth
    // user still owns it, yet the invite page showed a plain "sign in" screen. PATCH reactivation already
    // refuses a deleted account; the invite path never did. Checked before the related-row analysis so a
    // deleted former member gets this message rather than a "Reactivate them instead" pointer to a
    // reactivation that would itself refuse. The wording stays neutral rather than announcing that an
    // account was deleted, since this endpoint would otherwise confirm that to anyone probing addresses.
    if (existingUser?.deleted_at) {
      return NextResponse.json({
        error: 'This address can\u2019t be invited right now. If the person recently closed their ScopeGov account, they can be invited again once it has been fully removed (up to 30 days), or you can invite a different address.',
      }, { status: 409 })
    }

    // Every membership row in this workspace that already belongs to this
    // person: matched by account AND by invited address, because an invite
    // sent before they registered has no user_id yet.
    const memberSelect = 'id,status,user_id,invited_email,invite_token_expires_at,joined_at'
    const [byEmailRes, byUserRes] = await Promise.all([
      (service as any).from('workspace_members').select(memberSelect)
        .eq('workspace_id', wsId).eq('invited_email', normalizedEmail),
      existingUser
        ? (service as any).from('workspace_members').select(memberSelect)
            .eq('workspace_id', wsId).eq('user_id', existingUser.id)
        : Promise.resolve({ data: [] }),
    ])
    // Not "no existing rows": that skipped the already-a-member / deactivated / pending guards and let the unique
    // index answer instead, with a misleading "An invite is already pending".
    if (byEmailRes.error || byUserRes.error)
      return NextResponse.json({ error: 'Could not check this address. Please try again.' }, { status: 500 })
    const relatedRows = [...(byEmailRes.data || []), ...(byUserRes.data || [])]
      .filter((r: any, i: number, all: any[]) => all.findIndex(x => x.id === r.id) === i)
    const related: any[] = relatedRows || []
    // An invite whose expiry has passed is dead even if the daily cron hasn't flipped it to
    // 'expired' yet — treat it as expired so it neither blocks a new invite nor is reported as pending.
    const isLapsed = (r: any) => r.status === 'invited' && !!r.invite_token_expires_at
      && new Date(r.invite_token_expires_at).getTime() <= Date.now()
    const byStatus = (st: string) => related.find(r =>
      st === 'invited' ? (r.status === 'invited' && !isLapsed(r)) : r.status === st)

    if (byStatus('active'))
      return NextResponse.json({ error: 'This person is already a member of the workspace' }, { status: 409 })
    if (byStatus('invited'))
      return NextResponse.json({ error: 'An invite is already pending for this email' }, { status: 409 })
    // FIX (Team & Invites round 16 — B2): only a deactivated row that really was a member (joined_at set) can be
    // reactivated. A deactivated row that never had one is a leftover invite: the Reactivate this branch used to
    // offer refuses it ("never accepted… send a new invite"), leaving the address permanently un-invitable. Those
    // rows are cleared below together with the expired ones (which also frees the (workspace_id, user_id) slot).
    const isStaleDeactivated = (r: any) => r.status === 'deactivated' && !r.joined_at
    const realDeactivated = related.find(r => r.status === 'deactivated' && !isStaleDeactivated(r))
    if (realDeactivated)
      return NextResponse.json({
        error: 'This person was deactivated in this workspace. Reactivate them from the Deactivated list instead of sending a new invite \u2014 that restores the access their role already had.',
        reactivateMemberId: realDeactivated.id,
      }, { status: 409 })

    const seatCheck = await checkSeatLimit(service, wsId, session.planTier, ['active', 'invited'])
    if (!seatCheck.ok)
      return NextResponse.json({ error: seatCheck.message, upgradeRequired: true }, { status: 403 })

    // Expired, never-accepted invites for this address carry nothing worth
    // keeping; clear them so the new invite is the only row.
    // FIX (Team & Invites independent pass — invite email with a dead link): the invite URL is built from
    // NEXT_PUBLIC_APP_URL with no check (the Copy-link route already refuses when it is unset). With the
    // variable missing the email read "undefined/invite/<token>" and the admin was told it was sent. Refuse
    // BEFORE anything is deleted or written, so a misconfigured deploy fails loudly instead of mailing a dead link.
    if (!process.env.NEXT_PUBLIC_APP_URL)
      return NextResponse.json({ error: 'The app URL is not configured, so an invite link can\u2019t be built.' }, { status: 500 })

    const expiredIds = related.filter(r => r.status === 'expired' || isLapsed(r) || isStaleDeactivated(r)).map(r => r.id)
    if (expiredIds.length > 0) {
      // Status-guarded like every other delete of a never-accepted row: an accept racing this can't lose its row.
      const { error: clearErr } = await (service as any).from('workspace_members').delete().in('id', expiredIds)
        .or('status.in.(invited,expired),and(status.eq.deactivated,joined_at.is.null)')
      // If the stale rows survive, the insert below trips the unique index and reports "already pending".
      if (clearErr) return NextResponse.json({ error: 'Could not prepare the invite. Please try again.' }, { status: 500 })
    }

    const inviteToken   = nanoid(32)
    const expiresAt     = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const { data: member, error: memberErr } = await (service as any)
      .from('workspace_members')
      .insert({
        workspace_id:            wsId,
        user_id:                 existingUser?.id || null,
        invited_email:           normalizedEmail,
        role_id:                 role?.id || null,
        effective_permissions:   '{}',
        status:                  'invited',
        invite_token:            inviteToken,
        invite_token_expires_at: expiresAt.toISOString(),
        invited_at:              new Date().toISOString(),
        invited_by:              session.id,
      })
      .select('id').single()

    if (memberErr) {
      // Two invites for the same address racing each other: the unique index lets one through.
      if ((memberErr as any).code === '23505')
        return NextResponse.json({ error: 'An invite is already pending for this email' }, { status: 409 })
      throw new Error(memberErr.message)
    }

    // FIX (Team & Invites independent pass — H1): the seat check above and this insert aren't atomic.
    // Re-count now that our row exists; if a concurrent invite/reactivation took the last seat, undo
    // ours (see seatLimitBreachedAfterWrite).
    const postSeat = await seatLimitBreachedAfterWrite(service, wsId, session.planTier, ['active', 'invited'])
    if (!postSeat.ok) {
      await (service as any).from('workspace_members').delete().eq('id', member.id).eq('status', 'invited')
      return NextResponse.json({ error: postSeat.message, upgradeRequired: true }, { status: 403 })
    }

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
    //
    // FIX (deep audit, Settings + Team re-pass round 2 — MEDIUM): the plain
    // try/catch above never actually caught this. Per lib/email/delivery.ts's
    // own header comment, the Resend SDK reports an unverified domain, a
    // quota limit, or an invalid recipient by RESOLVING with
    // `{ data: null, error }` — it does not throw. sendInviteEmail() (and
    // every send*Email helper) forwards that resolved value straight through
    // from sendEmail(), so `emailSent` here was unconditionally true even
    // when the provider had rejected the message outright: the invite sat
    // as "Pending" forever with no signal to the admin, exactly the failure
    // mode the comment above describes — the fix just never reached this
    // call site. checkedSend() (already used by every other email call in
    // the app — team member-changed emails, invoice/SOW/CO reminders,
    // ownership transfer, …) is the one place both failure shapes (thrown or
    // resolved-with-error) are normalized; use it here too.
    const delivery = await checkedSend(() => sendInviteEmail({
      to:            normalizedEmail,
      inviterName:   session.name,
      workspaceName: ws?.name || session.agencyName,
      agencyName:    session.agencyName,
      roleName:      role?.name,
      inviteUrl,
      expiresAt:     expiresAt.toISOString(),
    }), 'invite email')
    const emailSent = delivery.ok

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
      metadata: { role_id: role?.id ?? null, role_name: role?.name ?? null, ...(emailSent ? {} : { email_send_failed: true }) },
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
