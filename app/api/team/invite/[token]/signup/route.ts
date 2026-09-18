import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { checkSeatLimit } from '@/lib/utils/seat-limit'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }             = await params
    const { name: rawName, password } = await request.json()

    // FIX (deep audit, Auth+MFA section, standalone pass): `name` used to
    // be forwarded as `name.trim()` with no length cap, unlike every
    // structurally comparable field in this codebase (agency_name,
    // workspace name), which goes through sanitizeDisplayName() (120-char
    // cap, strips CR/LF/control chars). Applying it here at the one place
    // this route sets the name — both the new auth user's metadata and
    // the immediately-following public.users upsert, which overwrites
    // whatever handle_new_user()'s own trigger-level cap (042) just wrote,
    // so the trigger fix alone doesn't cover this call site.
    const name = sanitizeDisplayName(rawName)

    if (!name)         return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    if (!password || password.length < 8)
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })

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
      user_metadata: { name },
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

    await (service as any).from('users').upsert({
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
        effective_permissions: defaultRole?.permissions || '{}',
        role_id: member.role_id || defaultRole?.id || null,
      })
      .eq('id', member.id)

    if (activateErr) throw new Error(`Membership activation failed: ${activateErr.message}`)

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
