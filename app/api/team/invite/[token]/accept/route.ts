import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'
import { checkSeatLimit } from '@/lib/utils/seat-limit'
import { inviterMayStillGrant } from '@/lib/utils/invite-authority'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }  = await params
    const supabase   = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id,status,workspace_id,invite_token_expires_at,invited_email,invited_by,role_id,workspaces(name,deleted_at,plan_tier)')
      .eq('invite_token', token)
      .single()

    if (!member) return NextResponse.json({ error: 'Invalid invite token' }, { status: 404 })
    if (member.status === 'active')
      return NextResponse.json({ error: 'Invite already accepted' }, { status: 409 })
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
    // CRITICAL): this only ever checked for status === 'active' (already
    // used). A 'deactivated' invite — produced either by an admin
    // explicitly revoking it (app/api/team/[id]'s DELETE handler now
    // hard-deletes a never-accepted invite instead, but that fix landed
    // AFTER this route and doesn't retroactively cover invites revoked
    // before it shipped) or by workspace/delete/route.ts mass-deactivating
    // every member row — including still-pending invites — when a
    // workspace is deleted, fell through this check exactly like a
    // still-valid 'invited' row and was silently reactivated to 'active'.
    // Migration 036's own comment argues this is safe for the deleted-
    // workspace case specifically because the row is "never reachable"
    // once its workspace is gone — but that's only true of the Team page's
    // Reactivate button. This route is reachable directly via the token
    // link with no workspace-visibility check at all, regardless of
    // whether the workspace still shows up anywhere in the UI.
    if (member.status === 'deactivated')
      return NextResponse.json({ error: 'This invite is no longer valid.' }, { status: 410 })
    // FIX (same finding): belt-and-braces even if a 'deactivated' row is
    // somehow missed above (workspace deletion deactivates members but
    // leaves the workspace's OWN row otherwise untouched apart from
    // deleted_at) — never let ANY invite reactivate access to a workspace
    // that's been soft-deleted.
    if (member.workspaces?.deleted_at)
      return NextResponse.json({ error: 'This invite is no longer valid.' }, { status: 410 })

    const expires = new Date(member.invite_token_expires_at)
    if (expires < new Date())
      return NextResponse.json({ error: 'Invite expired' }, { status: 410 })

    // This route sits under the public /api/team/invite/ prefix (a brand-new invitee
    // has no workspace yet), so the middleware's second-factor gate does not cover
    // it. A password-only session for an account that HAS a second factor must not
    // be able to attach new memberships.
    const { data: aalNow } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aalNow?.nextLevel === 'aal2' && aalNow.currentLevel !== 'aal2') {
      return NextResponse.json({ error: 'Complete two-factor verification before accepting this invite.', code: 'mfa_required' }, { status: 403 })
    }

    // The invite is only as good as its sender's authority NOW (see lib/utils/invite-authority.ts).
    if (!(await inviterMayStillGrant(service, member.workspace_id, member.invited_by, member.role_id))) {
      return NextResponse.json({
        error: 'This invite is no longer valid — the person who sent it can no longer grant this role. Ask a workspace admin to send a new one.',
      }, { status: 410 })
    }

    // Verify the accepting account matches the invited address — prevents
    // a leaked token being accepted by an unrelated account.
    if (member.invited_email && user.email?.toLowerCase() !== member.invited_email.toLowerCase()) {
      return NextResponse.json({
        error: `This invite was sent to ${member.invited_email}. Please sign in with that email address.`,
      }, { status: 403 })
    }

    // FIX (deep audit, section 6 — flagship finding): the seat limit was
    // only ever checked at invite-creation time (api/team/invite POST) —
    // nothing re-checked it here, at the point the row actually becomes
    // 'active'. The workspace's plan can change between an invite being
    // sent and accepted (a downgrade, or an external Paystack subscription
    // change via the webhook), and the invite-creation check only ever
    // reserved a seat among 'active'+'invited' rows at the moment it was
    // sent — it never re-validates against the plan that's current NOW.
    // Only count 'active' here: this row is still 'invited', not part of
    // the active headcount yet, and it's the count of members who would
    // actually be active immediately after this that has to fit the plan.
    const seatCheck = await checkSeatLimit(service, member.workspace_id, member.workspaces?.plan_tier, ['active'])
    if (!seatCheck.ok) {
      // Reworded for the invitee (who has no workspace access yet, so
      // "deactivate a member" / "upgrade in Settings" — checkSeatLimit's
      // own admin-facing phrasing — wouldn't make sense here).
      return NextResponse.json({
        error: 'This workspace is currently full for its plan. Ask a workspace admin to free up a seat or upgrade the plan, then try this invite link again.',
      }, { status: 409 })
    }

    const now = new Date().toISOString()

    // Get default role for this workspace
    const { data: defaultRole } = await (service as any)
      .from('roles')
      .select('id,permissions')
      .eq('workspace_id', member.workspace_id)
      .eq('is_default', true)
      .single()

    // Activate membership
    // BUG FIX (Fix 3): don't null invite_token — see signup/route.ts for why.
    const { data: activated, error: activateErr } = await (service as any).from('workspace_members').update({
      user_id:              user.id,
      status:               'active',
      joined_at:            now,
      role_id:              member.role_id || defaultRole?.id || null,
      // FIX (deep audit, Team & Invites section): this wrote the DEFAULT
      // role's permissions even when the inviter had explicitly chosen a
      // different role on the line above. It was correct only by
      // accident: trg_member_effective_permissions is
      // `BEFORE INSERT OR UPDATE OF permission_overrides, role_id`, and
      // role_id IS in this SET list, so the trigger fired and recomputed
      // the right value, discarding what the app wrote. Remove the field
      // rather than leave a wrong value that happens to be overwritten —
      // drop role_id from this update for any future reason and every
      // invitee would silently land on the default role's permissions
      // regardless of what they were invited as, with nothing to catch it.
    }).eq('id', member.id).eq('status', 'invited').select('id')

    // Nothing else may happen (active workspace switch, audit, notifications)
    // unless the membership really flipped to active — a failed write, or a
    // second simultaneous accept that lost the race, must not report success.
    if (activateErr) {
      console.error('Invite accept: membership update failed:', activateErr)
      return NextResponse.json({ error: 'Could not accept this invite. Please try again.' }, { status: 500 })
    }
    if (!activated || activated.length === 0) {
      return NextResponse.json({ error: 'This invite has already been accepted or is no longer valid.' }, { status: 409 })
    }

    // Ensure user row exists (BUG-002: INSERT policy + service role)
    // FIX (round 3, Workspace lifecycle Finding 5): this used to be an
    // unconditional .upsert() that overwrote `name` with
    // user.user_metadata.name (the ORIGINAL signup-time value, which never
    // changes) on every invite acceptance — not just the first. An
    // existing user who renamed themselves via workspace/profile/route.ts
    // and later accepted an invite to a SECOND workspace got their display
    // name silently reverted. This is the exact same pattern
    // workspace/create/route.ts's own Finding 5 already fixed for
    // workspace creation — same bug, missed in this second location.
    // Distinguish insert (brand-new user row, safe to seed a name) from
    // update (existing row, whose name is the user's own to keep) instead
    // of upserting blindly.
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): also
    // select `name` here — see the logAudit call below's own comment.
    const { data: existingUserRow } = await (service as any)
      .from('users').select('id,name').eq('id', user.id).maybeSingle()
    if (existingUserRow) {
      await (service as any).from('users').update({
        email:                user.email,
        active_workspace_id:  member.workspace_id,
        email_verified_at:    user.email_confirmed_at || now, // invited = pre-verified (spec §16.0)
      }).eq('id', user.id)
    } else {
      await (service as any).from('users').insert({
        id:                   user.id,
        email:                user.email,
        name:                 sanitizeDisplayName(user.user_metadata?.name),
        active_workspace_id:  member.workspace_id,
        email_verified_at:    user.email_confirmed_at || now,
      })
    }

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
    // used user.user_metadata?.name — the ORIGINAL signup-time value,
    // frozen forever, never touched by workspace/profile's rename (that
    // route only ever writes public.users.name, never Auth metadata).
    // This is the exact same staleness pattern workspace/create's own
    // Finding 5 comment claims was uniquely fixed for that route — it
    // wasn't; this second call site was missed. An existing user who
    // renamed themselves and later accepted an invite to a second
    // workspace got their OLD name permanently baked into this specific
    // audit-log row. existingUserRow?.name (fetched above) is the
    // canonical current value when this is an existing user; falls back
    // to Auth metadata and finally email for a brand-new user row, same
    // order every other call site in this section now uses.
    await logAudit(service, {
      workspaceId: member.workspace_id,
      actorId: user.id, actorEmail: user.email!,
      actorName: existingUserRow?.name || user.user_metadata?.name || user.email!,
      eventType: 'member.joined', entityType: 'workspace_member',
      entityId: member.id, entityName: user.email!,
      metadata: { workspace_name: member.workspaces?.name },
    })

    // FEATURE (Notifications & email fix round): the person who invited someone was never told they
    // had joined. In-app to the people who can manage the team.
    await notifyMembersWithPermission(service, {
      workspaceId: member.workspace_id, permission: 'INVITE_MEMBERS', eventType: 'member_joined',
      type: 'member_joined', title: 'New teammate joined',
      body: `${existingUserRow?.name || user.user_metadata?.name || user.email} accepted their invite and joined ${member.workspaces?.name || 'the workspace'}.`,
      entityType: 'team', excludeUserId: user.id,
    })

    return NextResponse.json({ ok: true, workspaceId: member.workspace_id })
  } catch (err) {
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): same
    // info-disclosure pattern already fixed for every route in this
    // section (workspace/create, complete-onboarding, leave, profile) —
    // this catch-all was returning the raw exception message straight to
    // the client. Log server-side only.
    console.error('Invite accept error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
