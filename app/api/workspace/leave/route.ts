// app/api/workspace/leave/route.ts
//
// Self-service "leave a workspace" — distinct from the admin-side
// DELETE /api/team/[id] (which deactivates someone ELSE and explicitly
// blocks deactivating yourself there, since that route is for team
// management, not self-removal). This is what the workspace switcher's
// "Leave" action calls.

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
      if (leaveErr.message?.includes('not_a_member')) {
        return NextResponse.json({ error: 'Not a member of that workspace' }, { status: 404 })
      }
      return NextResponse.json({ error: leaveErr.message }, { status: 500 })
    }

    await logAudit(service, {
      workspaceId, actorId: user.id, actorEmail: user.email || '', actorName: user.email || '',
      eventType: 'member.left', entityType: 'workspace_member', entityId: member.id,
      entityName: member.workspaces?.name || '', metadata: {},
    }).catch(() => {})

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
