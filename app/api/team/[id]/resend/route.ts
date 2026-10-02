export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendInviteEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { nanoid } from 'nanoid'
import { checkInviteRateLimit } from '@/lib/utils/rate-limit'
import { checkSeatLimit, seatLimitBreachedAfterWrite } from '@/lib/utils/seat-limit'
import { roleWithinCeiling } from '@/lib/utils/permission-ceiling'
import { roleGrantedAtAcceptance } from '@/lib/utils/invite-authority'

// FIX (deep audit, Team & Invites section — HIGH, destructive): "Resend"
// in components/team/TeamClient.tsx was implemented as DELETE-then-POST:
//
//     const delRes = await fetch(`/api/team/${m.id}`, { method: 'DELETE' })
//     if (!delRes.ok) { ...; return }
//     const res = await fetch('/api/team/invite', { ... })
//     if (!res.ok) { setError(...); return }   // ← original already gone
//
// That shape was itself a fix for an earlier bug (PATCH { status } was a
// silent no-op, so the follow-up POST always 409'd on the still-present
// row). It solved that, but turned a retry into a destructive operation:
// because DELETE now correctly HARD-deletes a never-accepted invite, a
// POST that fails for any reason leaves nothing behind at all.
//
// Four realistic ways that second call fails after the first one lands:
//   - checkInviteRateLimit — the DELETE doesn't (and shouldn't) remove
//     the 'member.invited' audit row that counts toward the window, so
//     resending a few invites in quick succession trips the limiter
//   - checkSeatLimit — the plan changed since the invite was created
//   - the role assigned to the original invite has since been deleted
//   - roleWithinCeiling — the person clicking Resend holds LESS than the
//     person who originally sent it, so they can't recreate it
//
// In all four the admin sees an error, the row disappears from the
// table, and the invitee's still-live link is now dead. Nothing in the
// UI explains that the invite was destroyed rather than left alone.
//
// Resending an invite doesn't need a new row at all — it needs a fresh
// token, a fresh expiry, and another email. Doing that in place on the
// existing row is atomic by construction: if the email send fails, the
// invite is exactly as it was, and the response says so. It preserves
// role_id and invited_at, but it DOES re-attribute invited_by to whoever
// clicked Resend (the ceiling check below is what makes that safe): the
// accept route re-checks that the inviter of record can still grant the
// role, so the person re-issuing the invite has to be the one vouching for
// it. The previous inviter is recorded in the audit entry.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'INVITE_MEMBERS'))
      return NextResponse.json({ error: 'Missing permission: INVITE_MEMBERS' }, { status: 403 })

    const service = createServiceClient()

    // Rate limit applies here for the same reason it applies to creation:
    // this sends real email to an arbitrary address. Checked BEFORE any
    // write, so a rate-limited resend leaves the existing invite fully
    // intact — the exact property the old delete-first flow lacked.
    const limited = await checkInviteRateLimit(service, session.workspaceId)
    if (!limited.allowed)
      return NextResponse.json({ error: limited.message }, { status: 429 })

    const { data: member, error: memberErr } = await (service as any)
      .from('workspace_members')
      .select('id,status,role_id,invited_email,user_id,invited_by,invite_token,invite_token_expires_at,roles(name,permissions),users!workspace_members_user_id_fkey(email)')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()

    // A failed read is not "no such invite": answering 404 told the admin the invite was gone.
    if (memberErr) return NextResponse.json({ error: 'Could not load this invite. Please try again.' }, { status: 500 })
    if (!member) return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
    if (member.status === 'active')
      return NextResponse.json({ error: 'This person has already accepted — there is nothing to resend.' }, { status: 409 })
    if (member.status === 'deactivated')
      return NextResponse.json({ error: 'This membership was deactivated. Reactivate it instead of resending an invite.' }, { status: 409 })
    if (member.status !== 'invited' && member.status !== 'expired')
      return NextResponse.json({ error: 'This invite can no longer be resent.' }, { status: 409 })

    // Resending re-issues the invite under THIS person's name, so it is subject to the
    // same "only hand out a role you already hold" ceiling as creating one — otherwise
    // any INVITE_MEMBERS holder could keep alive (and re-attribute to themselves) an
    // invite for a role they could never have issued.
    // An invite with no role is given the workspace default at acceptance, so THAT is the role checked.
    const grantedRole = member.roles ?? (member.role_id ? null : await roleGrantedAtAcceptance(service, session.workspaceId, null))
    if (grantedRole && !roleWithinCeiling(session, grantedRole))
      return NextResponse.json({ error: 'Cannot resend an invite for a role with permissions you don\u2019t hold yourself' }, { status: 403 })

    const email = member.invited_email || member.users?.email
    if (!email) return NextResponse.json({ error: 'This invite has no email address on record.' }, { status: 400 })

    // FIX (Team & Invites independent pass — resend replaced a working link with a dead one): the new link is
    // built from NEXT_PUBLIC_APP_URL, unguarded. With it unset the old token was rotated out and the email said
    // "undefined/invite/<token>". Refuse before the token is touched (same rule as the Copy-link route).
    if (!process.env.NEXT_PUBLIC_APP_URL)
      return NextResponse.json({ error: 'The app URL is not configured, so an invite link can\u2019t be built.' }, { status: 500 })

    // No seat re-check here: this row already occupies its seat under the
    // ['active','invited'] count that invite creation reserved. An
    // 'expired' row returning to 'invited' reclaims the seat it never
    // actually released, so resending can't push a workspace over its
    // limit. Acceptance re-checks against 'active' regardless, which is
    // the check that actually matters.
    // An expired invite no longer holds a seat (invite creation only counts
    // active and pending ones), so bringing it back has to pass the same seat
    // check a fresh invite does.
    // A row still flagged 'invited' whose expiry has passed (the daily cron hasn't flipped it yet) is
    // expired in every way that matters: it holds no seat (checkSeatLimit ignores it) and the Team page
    // lists it under Expired. Treat it the same here.
    const lapsedNow = member.status === 'invited' && !!member.invite_token_expires_at
      && new Date(member.invite_token_expires_at).getTime() <= Date.now()
    if (member.status === 'expired' || lapsedNow) {
      const seatCheck = await checkSeatLimit(service, session.workspaceId, session.planTier, ['active', 'invited'])
      if (!seatCheck.ok)
        return NextResponse.json({ error: seatCheck.message, upgradeRequired: true }, { status: 403 })
    }

    const previous = {
      invite_token:            member.invite_token,
      invite_token_expires_at: member.invite_token_expires_at,
      status:                  member.status,
      invited_by:              member.invited_by ?? null,
    }
    const inviteToken = nanoid(32)
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    // FIX (independent re-audit, Team & Invites section — flagship finding):
    // no busy-guard exists anywhere in this flow — not in TeamClient.tsx (see
    // that file's own fix note) and not here. Two admins clicking Resend on
    // the same pending invite within the same second (or one admin
    // double-clicking before the button disables) both read the same
    // `member` row, both mint a fresh token, and both write. Only the LATER
    // write survives; if the EARLIER call's email is what actually reaches
    // the invitee's inbox, they click a link whose token this second write
    // already replaced — dead on arrival — while both admins see a plain
    // "Invite resent" success with no way to know one of the two sends is
    // now worthless. Compare-and-swap on the exact token this request read:
    // if it's no longer there, someone else already resent (or accepted, or
    // revoked) this invite between our read and our write, and we say so
    // instead of silently overwriting whatever they just did.
    //
    // FIX (Team & Invites independent pass — resend resurrects an accepted member): the token alone is NOT
    // a usable CAS against an accept. accept/signup deliberately leave `invite_token` on the row when they
    // flip it to 'active', so an accept landing between our SELECT and this UPDATE still matched the old
    // token — and this write then set the freshly-activated member back to status 'invited' with a new
    // token and a new invited_by (joined_at/user_id stayed set): the person lost access the moment they
    // got it, and a "resent" email went out for a member who was already in. Only a row that is STILL
    // pending (invited/expired) may be re-issued, so the status is part of the compare-and-swap too — the
    // same guard the link route and the role-change re-attribution already carry.
    let updateQuery = (service as any)
      .from('workspace_members')
      .update({
        invite_token:            inviteToken,
        invite_token_expires_at: expiresAt.toISOString(),
        status:                  'invited',
        invited_by:              session.id,
      })
      .eq('id', id).eq('workspace_id', session.workspaceId)
      .in('status', ['invited', 'expired'])
    if (member.invite_token) updateQuery = updateQuery.eq('invite_token', member.invite_token)
    const { data: updatedRows, error: updateErr } = await updateQuery.select('id')

    if (updateErr) {
      console.error('Invite resend update failed:', updateErr)
      return NextResponse.json({ error: 'Could not resend this invite. Try again.' }, { status: 500 })
    }
    if (!updatedRows || updatedRows.length === 0) {
      return NextResponse.json({
        error: 'This invite was just changed by someone else \u2014 possibly resent or accepted a moment ago. Refresh the Team page to see its current state before trying again.',
      }, { status: 409 })
    }

    // FIX (Team & Invites independent pass — H1): reviving an expired invite takes a seat, and the check
    // above isn't atomic with this write. Re-count; if a concurrent invite/reactivation took the last
    // seat, put the invite back exactly as it was (compare-and-swap on the token we just wrote).
    if (member.status === 'expired' || lapsedNow) {
      const postSeat = await seatLimitBreachedAfterWrite(service, session.workspaceId, session.planTier, ['active', 'invited'])
      if (!postSeat.ok) {
        await (service as any).from('workspace_members').update({
          invite_token: previous.invite_token, invite_token_expires_at: previous.invite_token_expires_at,
          status: previous.status, invited_by: previous.invited_by,
        }).eq('id', id).eq('invite_token', inviteToken).eq('status', 'invited')
        return NextResponse.json({ error: postSeat.message, upgradeRequired: true }, { status: 403 })
      }
    }

    const { data: ws } = await (service as any)
      .from('workspaces').select('name,agency_name').eq('id', session.workspaceId).maybeSingle()

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invite/${inviteToken}`
    // FIX (deep audit, Settings + Team re-pass round 2 — MEDIUM): same gap as
    // POST /api/team/invite — see that route's fix note. The plain try/catch
    // here never caught a provider rejection either (Resend resolves with
    // `{ data: null, error }`, it doesn't throw), so the restore-the-previous-
    // token rollback right below — which is otherwise exactly the right
    // behaviour — never actually ran on the failure mode it exists for. The
    // old link died, the new one never arrived, and the admin was told
    // nothing was wrong.
    const delivery = await checkedSend(() => sendInviteEmail({
      to:            email,
      inviterName:   session.name,
      workspaceName: ws?.name || session.agencyName,
      agencyName:    session.agencyName,
      roleName:      member.roles?.name,
      inviteUrl,
      expiresAt:     expiresAt.toISOString(),
    }), 'invite resend email')
    const emailSent = delivery.ok

    // The new link never reached the invitee, so put the previous one back:
    // a link they already hold keeps working instead of being replaced by one
    // they never received.
    if (!emailSent) {
      const { error: restoreErr } = await (service as any)
        .from('workspace_members').update(previous)
        .eq('id', id).eq('workspace_id', session.workspaceId).eq('invite_token', inviteToken).eq('status', 'invited')
      if (restoreErr) console.error('Invite resend: could not restore previous token:', restoreErr)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'member.invite_resent', entityType: 'workspace_member',
      entityId: id, entityName: email,
      metadata: {
        ...(emailSent ? {} : { email_send_failed: true }),
        ...(previous.invited_by && previous.invited_by !== session.id ? { previous_inviter_id: previous.invited_by } : {}),
      },
    })

    // Only an invite that was still live keeps a working link after a failed resend; an expired one
    // goes back to expired, so the old link is dead either way.
    const previousStillLive = previous.status === 'invited' && !!previous.invite_token_expires_at
      && new Date(previous.invite_token_expires_at).getTime() > Date.now()
    return NextResponse.json({ ok: true, ...(emailSent ? {} : { emailFailed: true, previousLinkStillWorks: previousStillLive }) })
  } catch (err) {
    console.error('Invite resend error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
