import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { checkSeatLimit } from '@/lib/utils/seat-limit'
import { validatePassword } from '@/lib/auth/password-policy'
import { TERMS_VERSION } from '@/lib/auth/terms'

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

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id, status, invite_token_expires_at, invited_email, workspace_id, role_id, workspaces(name,deleted_at,plan_tier)')
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

    const { error: userRowErr } = await (service as any).from('users').upsert({
      id: userId, email, name,
      email_verified_at: now,
      active_workspace_id: member.workspace_id,
    }, { onConflict: 'id' })

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
    const { error: activateErr } = await (service as any)
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
      .eq('id', member.id)

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
      console.error('Membership activation failed, rolling back auth user:', activateErr)
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
