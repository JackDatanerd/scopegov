import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { checkSeatLimit } from '@/lib/utils/seat-limit'
import { validatePassword } from '@/lib/auth/password-policy'
import { TERMS_VERSION } from '@/lib/auth/terms'
import { inviterMayStillGrant } from '@/lib/utils/invite-authority'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }             = await params
    const body = await request.json().catch(() => null)
    const rawName  = body?.name
    const password = body?.password

    const name = sanitizeDisplayName(typeof rawName === 'string' ? rawName : '')

    if (!name)         return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    const policyError = validatePassword(password)
    if (policyError) return NextResponse.json({ error: policyError }, { status: 400 })
    // Same consent basis as the public sign-up page: the Terms and Privacy
    // Policy were shown next to the button, and the version is recorded.
    if (body?.acceptedTerms !== true)
      return NextResponse.json({ error: 'Please accept the Terms and Privacy Policy to create your account.' }, { status: 400 })

    const service = createServiceClient()

    // FIX (deep audit, Settings + Team re-pass round 2 — MEDIUM): invited_by
    // is now selected so the inviter-authority check below can run — see
    // that check's own comment for why it was missing entirely on this path.
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id, status, invite_token_expires_at, invited_email, invited_by, workspace_id, role_id, workspaces(name,deleted_at,plan_tier)')
      .eq('invite_token', token)
      .single()

    if (!member) {
      return NextResponse.json({
        error: 'This invite link has already been used. Try signing in directly.',
        alreadyUsed: true,
      }, { status: 409 })
    }

    if (member.status === 'active') {
      return NextResponse.json({
        error: 'You are already a member. Sign in to continue.',
        alreadyMember: true,
        email: member.invited_email,
      }, { status: 409 })
    }
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
    // CRITICAL): same gap as accept/route.ts (see its own comment for the
    // full story) — this only ever checked for 'active' (already used),
    // never 'deactivated' (a revoked invite, or one orphaned by
    // workspace/delete/route.ts mass-deactivating every member row —
    // including pending invites — when the workspace is soft-deleted).
    // A brand-new account could be created and immediately activated into
    // a dead workspace via this exact path.
    if (member.status === 'deactivated' || member.workspaces?.deleted_at) {
      return NextResponse.json({ error: 'This invite is no longer valid.' }, { status: 410 })
    }

    if (new Date(member.invite_token_expires_at) < new Date())
      return NextResponse.json({ error: 'This invite has expired. Ask the workspace owner to resend it.' }, { status: 410 })

    // FIX (deep audit, Settings + Team re-pass round 2 — MEDIUM): accept/
    // route.ts (an existing account accepting an invite) has re-checked "is
    // the invite only as good as its sender's authority NOW" since
    // inviterMayStillGrant() was introduced — see that route's own comment.
    // This sibling path, a brand-new account signing up straight from the
    // invite link, never called it at all: the exact same invite (same
    // token, same demoted/deactivated/downgraded inviter, same
    // no-longer-grantable role) that accept/route.ts correctly refuses with
    // 410 was silently honoured here instead, because a new user hits
    // signup rather than accept. Most invitees are new to the platform, so
    // this was the more commonly hit of the two paths, not a rare corner.
    if (!(await inviterMayStillGrant(service, member.workspace_id, member.invited_by, member.role_id))) {
      return NextResponse.json({
        error: 'This invite is no longer valid — the person who sent it can no longer grant this role. Ask a workspace admin to send a new one.',
      }, { status: 410 })
    }

    const email = member.invited_email
    if (!email) return NextResponse.json({ error: 'Invite email missing.' }, { status: 400 })

    // FIX (deep audit, section 6 — flagship finding): same gap as
    // accept/route.ts (see its own comment for the full story) — the seat
    // limit was never re-checked at the point membership actually becomes
    // 'active', only at invite-creation time. Checked before creating the
    // Supabase auth account below, not after, so a rejected signup here
    // never leaves behind an orphaned auth user with no workspace to join.
    const seatCheck = await checkSeatLimit(service, member.workspace_id, member.workspaces?.plan_tier, ['active'])
    if (!seatCheck.ok) {
      return NextResponse.json({
        error: 'This workspace is currently full for its plan. Ask a workspace admin to free up a seat or upgrade the plan, then try this invite link again.',
      }, { status: 409 })
    }

    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    let userId: string
    const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      // terms_version is picked up by handle_new_user(), which stamps the acceptance time.
      user_metadata: { name, terms_version: TERMS_VERSION },
    })

    if (createErr) {
      if (createErr.message.toLowerCase().includes('already') || createErr.message.toLowerCase().includes('exists')) {
        return NextResponse.json({
          error: 'An account with this email already exists. Sign in to accept the invite.',
          existingAccount: true,
          email,
        }, { status: 409 })
      }
      throw new Error(createErr.message)
    }

    userId = newUser.user.id
    const now = new Date().toISOString()

    // Best-effort rollback shared by every failure from here on: a real
    // Supabase Auth user already exists with a password set, so leaving it
    // behind on any subsequent failure is a real, sign-in-able account that
    // belongs to no workspace, permanently blocking a retry of this exact
    // signup ("already exists"). See the workspace_members activation
    // failure below, which this mirrors.
    const rollbackAuthUser = async (reason: string, err: unknown) => {
      console.error(reason, err)
      try {
        await (service as any).from('users').delete().eq('id', userId)
      } catch (cleanupErr) {
        console.error('Users-row rollback failed (non-fatal):', cleanupErr)
      }
      try {
        await adminClient.auth.admin.deleteUser(userId)
      } catch (cleanupErr) {
        console.error('Auth-user rollback failed (non-fatal):', cleanupErr)
      }
    }

    // FIX (deep audit, Settings + Team re-pass round 3 — silent-failure
    // gap): this error was fetched and never checked. handle_new_user()
    // (migration 001) already auto-creates a bare public.users row the
    // instant createUser() above inserts into auth.users, so a failure
    // here doesn't fail the FK on the workspace_members update just below
    // — that update goes on to succeed regardless, activating the person
    // into the workspace with whatever stale/default values the trigger
    // left (crucially, `active_workspace_id` pointing at nothing and
    // `email_verified_at` unset), and nothing anywhere signals that
    // anything went wrong. Treated exactly like the workspace_members
    // activation failure right below: fatal, with the same rollback, so a
    // failed signup is retryable rather than a member stuck with a wrong
    // active workspace and no error trail to explain why.
    const { error: userRowErr } = await (service as any).from('users').upsert({
      id: userId, email, name,
      email_verified_at: now,
      active_workspace_id: member.workspace_id,
    }, { onConflict: 'id' })

    if (userRowErr) {
      await rollbackAuthUser('Invite signup: users upsert failed, rolling back auth user:', userRowErr)
      return NextResponse.json({ error: 'Could not complete signup. Please try again.' }, { status: 500 })
    }

    const { data: defaultRole } = await (service as any)
      .from('roles').select('id, permissions')
      .eq('workspace_id', member.workspace_id).eq('is_default', true).single()

    // BUG FIX (Fix 3): previously set invite_token: null here. That made the
    // row unreachable by `.eq('invite_token', token)` the moment signup
    // succeeded, so re-visiting the same link produced a 404/500 from the
    // GET validate route instead of the intended "already accepted" message
    // (which relies on finding the row and checking status === 'active').
    // Reuse is already prevented by the status check above — the token can
    // stay on the row indefinitely.
    //
    // FIX (deep audit, Team & Invites re-pass — atomicity gap): this update
    // had no `.eq('status', 'invited')` guard, unlike its sibling
    // accept/route.ts (an existing account accepting the same invite),
    // whose own comment explains why one matters: "nothing else may happen
    // ... unless the membership really flipped to active." Two concurrent
    // signups against the same token both reading 'invited' before either
    // writes would otherwise let the second update silently overwrite the
    // first's user_id, leaving one real, password-protected auth account
    // orphaned with no membership pointing at it. In practice Supabase
    // Auth's own email-uniqueness constraint (both requests target the same
    // invited_email) already closes this for today's callers — but this
    // route shouldn't rely on that being true forever when the guard is one
    // clause and the failure mode is silent. Check the row really flipped,
    // exactly like accept/route.ts does, and roll back like every other
    // failure path in this route already does.
    const { data: activated, error: activateErr } = await (service as any)
      .from('workspace_members')
      .update({
        user_id: userId, status: 'active', joined_at: now,
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
        role_id: member.role_id || defaultRole?.id || null,
      })
      .eq('id', member.id).eq('status', 'invited').select('id')

    if (!activateErr && (!activated || activated.length === 0)) {
      await rollbackAuthUser(
        'Invite signup: lost the race to activate this membership (already activated elsewhere), rolling back auth user:',
        new Error('workspace_members row was no longer status=invited'),
      )
      return NextResponse.json({
        error: 'This invite has already been used. Try signing in directly.',
        alreadyUsed: true,
      }, { status: 409 })
    }
    if (activateErr) {
      // FIX (deep audit, Team & Invites re-pass — partial-failure gap):
      // by this point a real Supabase Auth user already exists with a
      // password set (adminClient.auth.admin.createUser above), and the
      // users upsert has already pointed active_workspace_id at this
      // workspace — but the workspace_members row that would actually
      // make them a member never flipped to 'active'. Left alone, that's
      // a real, password-protected account that can sign in but belongs
      // to no workspace, with the public.users row still describing them
      // as belonging to one they can't act in. A retry of signup would
      // also permanently fail from here on ("already exists"), routing
      // them to a sign-in screen for an account that can never accept
      // this invite. Best-effort roll back both writes so the person is
      // back to a clean, retryable state instead of stuck in limbo.
      await rollbackAuthUser('Membership activation failed, rolling back auth user:', activateErr)
      return NextResponse.json({ error: 'Could not complete signup. Please try again.' }, { status: 500 })
    }

    // FIX (deep audit, Team & Invites re-pass): accept/route.ts (an
    // already-registered user accepting an invite) logs 'member.joined' —
    // this path, a brand-new user accepting one, never did. Since most
    // invitees are new to the platform, this was the more common of the
    // two invite-acceptance flows, and it was the one missing from the
    // "immutable record."
    await logAudit(service, {
      workspaceId: member.workspace_id,
      actorId: userId, actorEmail: email, actorName: name,
      eventType: 'member.joined', entityType: 'workspace_member',
      entityId: member.id, entityName: email,
      metadata: { workspace_name: member.workspaces?.name },
    })

    // FEATURE (Notifications & email fix round): the person who invited someone was never told they
    // had joined. In-app to the people who can manage the team.
    await notifyMembersWithPermission(service, {
      workspaceId: member.workspace_id, permission: 'INVITE_MEMBERS', eventType: 'member_joined',
      type: 'member_joined', title: 'New teammate joined',
      body: `${name || email} accepted their invite and joined ${member.workspaces?.name || 'the workspace'}.`,
      entityType: 'team', excludeUserId: userId,
    })

    return NextResponse.json({ ok: true, email })
  } catch (err) {
    // FIX (deep audit, Team & Invites re-pass — the most severe instance
    // of this pattern in the section): this is a fully public,
    // unauthenticated endpoint — anyone with the invite link, no session
    // required, can trigger it — and it was still returning err.message
    // straight back in the response (including activateErr.message /
    // createErr.message re-thrown above, which can carry raw
    // Postgres/Supabase-Auth-Admin internals). Its sibling accept/route.ts
    // already gets this right: log server-side, return a generic message.
    // Bring this route in line with it.
    console.error('Invite signup error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
