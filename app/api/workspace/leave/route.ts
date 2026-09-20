// app/api/workspace/leave/route.ts
//
// Self-service "leave a workspace" — distinct from the admin-side
// DELETE /api/team/[id] (which deactivates someone ELSE and explicitly
// blocks deactivating yourself there, since that route is for team
// management, not self-removal). This is what the workspace switcher's
// "Leave" action calls.

import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { workspaceId } = await request.json()
    if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

    const service = createServiceClient()

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id, workspace_id, workspaces(name)')
      .eq('user_id', user.id).eq('workspace_id', workspaceId).eq('status', 'active')
      .maybeSingle()

    if (!member) return NextResponse.json({ error: 'Not a member of that workspace' }, { status: 404 })

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
    // audit entry's actorName used to just be user.email — the one place
    // in this section that never even tried the real display name, unlike
    // every sibling route (workspace/create, complete-onboarding) which
    // sources it from the canonical users.name, falling back to Auth
    // metadata and finally email only as a last resort.
    const { data: leavingUserRow } = await (service as any)
      .from('users').select('name').eq('id', user.id).maybeSingle()

    // FIX (deep audit, Workspace lifecycle section — TOCTOU race): the
    // last-member and sole-admin guards used to read the active-member
    // set, then write, as two separate steps with no lock between them —
    // two members leaving in the same instant could each pass their own
    // guard against the other's still-active row and both leave,
    // orphaning or de-adminning the workspace. Moved the whole
    // check-and-write into one SECURITY DEFINER RPC that takes row locks
    // up front, so a concurrent leave for the same workspace serializes
    // behind it and re-evaluates against the post-leave state — same
    // pattern this schema already uses for create_workspace_atomic and
    // purge_project/purge_workspace. Empirically verified against a real
    // concurrent-transaction test: exactly one of two simultaneous leaves
    // now succeeds; the workspace never drops below one active member.
    const { error: leaveErr } = await (service as any)
      .rpc('leave_workspace_atomic', { p_workspace_id: workspaceId, p_user_id: user.id })

    if (leaveErr) {
      if (leaveErr.message?.includes('last_member')) {
        return NextResponse.json({
          error: "You're the only member of this workspace — delete it instead of leaving it (Settings > Danger Zone).",
        }, { status: 400 })
      }
      if (leaveErr.message?.includes('sole_admin')) {
        return NextResponse.json({
          error: 'You\u2019re the only member who can manage workspace settings. Assign that ability to someone else first (Team > Roles), or delete the workspace instead if no one else should keep it.',
        }, { status: 400 })
      }
      // FIX (deep audit, RLS+permissions section): leave_workspace_atomic
      // (migration 034) now also refuses to let the sole MANAGE_ROLES
      // holder leave — same reasoning as sole_admin above, but for
      // permission/role management specifically, which can be held
      // independently of MANAGE_WORKSPACE_SETTINGS on a custom role.
      if (leaveErr.message?.includes('sole_roles_admin')) {
        return NextResponse.json({
          error: 'You\u2019re the only member who can manage roles and permissions. Assign that ability to someone else first (Team > Roles), or delete the workspace instead if no one else should keep it.',
        }, { status: 400 })
      }
      // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — see
      // migration 038): leaving a trial workspace you created would
      // otherwise permanently occupy your one-trial slot with no way back
      // in to delete it yourself afterward (workspace/delete requires an
      // active membership you'd no longer have). Point at the two real
      // ways out instead of letting it happen silently.
      if (leaveErr.message?.includes('trial_creator')) {
        return NextResponse.json({
          error: 'You created this trial workspace, so leaving it would lock you out of starting another trial with no way back in to delete it. Delete it instead (Settings > Danger Zone) if you want to abandon it, or upgrade it off the trial plan first if you\u2019d rather hand it off.',
        }, { status: 400 })
      }
      if (leaveErr.message?.includes('not_a_member')) {
        return NextResponse.json({ error: 'Not a member of that workspace' }, { status: 404 })
      }
      // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
      // was the one guard branch here that still returned the raw RPC
      // error message straight to the client — the exact info-disclosure
      // pattern already fixed for every OTHER route in this section
      // (workspace/create, complete-onboarding, profile), just missed
      // here because it lived in the fallback branch rather than an
      // obvious write-error check. Log server-side only.
      console.error('leave_workspace_atomic failed:', leaveErr)
      return NextResponse.json({ error: 'Could not leave that workspace. Try again.' }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId, actorId: user.id, actorEmail: user.email || '',
      actorName: leavingUserRow?.name || user.user_metadata?.name || user.email || '',
      eventType: 'member.left', entityType: 'workspace_member', entityId: member.id,
      entityName: member.workspaces?.name || '', metadata: {},
    }).catch(() => {})

    await notifyMembersWithPermission(service, {
      workspaceId: workspaceId, permission: 'INVITE_MEMBERS', eventType: 'member_joined',
      type: 'member_left', title: 'A teammate left',
      body: `${leavingUserRow?.name || user.user_metadata?.name || user.email} left the workspace.`,
      entityType: 'team', excludeUserId: user.id,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): same
    // leak, in the outer catch-all this time — an unexpected exception
    // (malformed body, a network-level Supabase client error) returned
    // its raw message straight to the client instead of the generic
    // message every other route in this section already gives here.
    console.error('Workspace leave error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
