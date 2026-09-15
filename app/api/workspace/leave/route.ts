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

    // Guard: don't let the last active member leave — that'd orphan the
    // workspace with no one able to manage it. Delete it instead (Danger
    // Zone) if that's genuinely the intent.
    const { data: activeMembers, count } = await (service as any)
      .from('workspace_members')
      .select('id, effective_permissions', { count: 'exact' })
      .eq('workspace_id', workspaceId).eq('status', 'active')

    if ((count ?? 0) <= 1) {
      return NextResponse.json({
        error: "You're the only member of this workspace — delete it instead of leaving it (Settings > Danger Zone).",
      }, { status: 400 })
    }

    // FIX (section-by-section re-audit, Workspace lifecycle Finding 2 —
    // CRITICAL): the headcount check above stops the literal last person
    // from leaving, but did nothing to stop the sole Owner from leaving a
    // workspace that still has other members — as long as 2+ people
    // remain, anyone (including the founder) could leave freely. If the
    // remaining members only hold the stock non-Owner roles (Account
    // Manager / Designer / Project Coordinator — all created with
    // MANAGE_ROLES:false, INVITE_MEMBERS:false,
    // MANAGE_WORKSPACE_SETTINGS:false), the workspace becomes headless:
    // nobody left can invite, edit roles, change settings, or even
    // delete the workspace to start over — no in-app recovery path.
    // Guard on MANAGE_WORKSPACE_SETTINGS specifically, since that's the
    // one permission that gates every other way out (including deleting
    // the workspace itself, per api/workspace/delete/route.ts).
    const leavingMemberRow = (activeMembers || []).find((m: any) => m.id === member.id)
    const leavingMemberIsAdminCapable = leavingMemberRow?.effective_permissions?.MANAGE_WORKSPACE_SETTINGS === true
    if (leavingMemberIsAdminCapable) {
      const anotherAdminRemains = (activeMembers || []).some((m: any) =>
        m.id !== member.id && m.effective_permissions?.MANAGE_WORKSPACE_SETTINGS === true
      )
      if (!anotherAdminRemains) {
        return NextResponse.json({
          error: 'You\u2019re the only member who can manage workspace settings. Assign that ability to someone else first (Team > Roles), or delete the workspace instead if no one else should keep it.',
        }, { status: 400 })
      }
    }

    const now = new Date().toISOString()
    await (service as any)
      .from('workspace_members')
      .update({ status: 'deactivated', deactivated_at: now })
      .eq('id', member.id)

    // If this was their active workspace, switch to another one they
    // belong to so they're not left pointing at a workspace they just left.
    const { data: userRow } = await (service as any)
      .from('users').select('active_workspace_id').eq('id', user.id).maybeSingle()

    if (userRow?.active_workspace_id === workspaceId) {
      const { data: other } = await (service as any)
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', user.id).eq('status', 'active')
        .order('created_at', { ascending: true }).limit(1).maybeSingle()

      await (service as any)
        .from('users').update({ active_workspace_id: other?.workspace_id || null }).eq('id', user.id)
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
