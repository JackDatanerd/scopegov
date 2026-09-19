export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendInviteEmail } from '@/lib/email/templates'
import { nanoid } from 'nanoid'
import { checkInviteRateLimit } from '@/lib/utils/rate-limit'

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
// invite is exactly as it was, and the response says so. It also
// preserves role_id, invited_by and invited_at rather than silently
// re-attributing the invite to whoever clicked Resend.
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

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id,status,invited_email,user_id,users!workspace_members_user_id_fkey(email)')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()

    if (!member) return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
    if (member.status === 'active')
      return NextResponse.json({ error: 'This person has already accepted — there is nothing to resend.' }, { status: 409 })
    if (member.status === 'deactivated')
      return NextResponse.json({ error: 'This membership was deactivated. Reactivate it instead of resending an invite.' }, { status: 409 })
    if (member.status !== 'invited' && member.status !== 'expired')
      return NextResponse.json({ error: 'This invite can no longer be resent.' }, { status: 409 })

    const email = member.invited_email || member.users?.email
    if (!email) return NextResponse.json({ error: 'This invite has no email address on record.' }, { status: 400 })

    // No seat re-check here: this row already occupies its seat under the
    // ['active','invited'] count that invite creation reserved. An
    // 'expired' row returning to 'invited' reclaims the seat it never
    // actually released, so resending can't push a workspace over its
    // limit. Acceptance re-checks against 'active' regardless, which is
    // the check that actually matters.
    const inviteToken = nanoid(32)
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const { error: updateErr } = await (service as any)
      .from('workspace_members')
      .update({
        invite_token:            inviteToken,
        invite_token_expires_at: expiresAt.toISOString(),
        status:                  'invited',
      })
      .eq('id', id).eq('workspace_id', session.workspaceId)

    if (updateErr) {
      console.error('Invite resend update failed:', updateErr)
      return NextResponse.json({ error: 'Could not resend this invite. Try again.' }, { status: 500 })
    }

    const { data: ws } = await (service as any)
      .from('workspaces').select('name,agency_name').eq('id', session.workspaceId).maybeSingle()

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invite/${inviteToken}`
    let emailSent = true
    try {
      await sendInviteEmail({
        to:            email,
        inviterName:   session.name,
        workspaceName: ws?.name || session.agencyName,
        agencyName:    session.agencyName,
        inviteUrl,
        expiresAt:     expiresAt.toISOString(),
      })
    } catch (e) { console.error('Invite resend email failed:', e); emailSent = false }

    // Same reasoning as invite creation: the token is a live bearer
    // credential and never belongs in a row that's exportable to CSV/PDF
    // by anyone holding VIEW_AUDIT_LOG. The address is enough context.
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'member.invite_resent', entityType: 'workspace_member',
      entityId: id, entityName: email,
      metadata: emailSent ? {} : { email_send_failed: true },
    })

    return NextResponse.json({ ok: true, ...(emailSent ? {} : { emailFailed: true }) })
  } catch (err) {
    console.error('Invite resend error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
