import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }  = await params
    const supabase   = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id,status,workspace_id,invite_token_expires_at,invited_email,role_id,workspaces(name,deleted_at)')
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

    // Verify the accepting account matches the invited address — prevents
    // a leaked token being accepted by an unrelated account.
    if (member.invited_email && user.email?.toLowerCase() !== member.invited_email.toLowerCase()) {
      return NextResponse.json({
        error: `This invite was sent to ${member.invited_email}. Please sign in with that email address.`,
      }, { status: 403 })
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
    await (service as any).from('workspace_members').update({
      user_id:              user.id,
      status:               'active',
      joined_at:            now,
      role_id:              member.role_id || defaultRole?.id || null,
      effective_permissions: defaultRole?.permissions || '{}',
    }).eq('id', member.id)

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
    const { data: existingUserRow } = await (service as any)
      .from('users').select('id').eq('id', user.id).maybeSingle()
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
        name:                 user.user_metadata?.name || '',
        active_workspace_id:  member.workspace_id,
        email_verified_at:    user.email_confirmed_at || now,
      })
    }

    await logAudit(service, {
      workspaceId: member.workspace_id,
      actorId: user.id, actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
      eventType: 'member.joined', entityType: 'workspace_member',
      entityId: member.id, entityName: user.email!,
      metadata: { workspace_name: member.workspaces?.name },
    })

    return NextResponse.json({ ok: true, workspaceId: member.workspace_id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
