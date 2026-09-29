// app/api/workspace/list/route.ts
//
// Lists every workspace the current user is an active member of, for the
// workspace switcher dropdown. This is what makes multi-workspace visible —
// getSession() only ever loads ONE workspace (the active one); this route
// is how the UI finds out there are others.

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { pickFallbackMembership } from '@/lib/auth/session'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    // FIX (Workspace lifecycle independent pass, round 20): this route authenticates
    // with getUser() alone, with no users.deleted_at check — same gap already fixed
    // for workspace/create, missed here (see that route's own comment; middleware.ts
    // deliberately never checks this for API routes). Self-service account/delete
    // is self-defended in practice (leaves every workspace first), but admin_suspend
    // deliberately leaves workspace_members untouched while banning the auth user —
    // a suspended person could otherwise still see their real workspace list for as
    // long as their already-issued access token stays valid.
    const [{ data: memberships }, { data: userRow }] = await Promise.all([
      (service as any)
        .from('workspace_members')
        .select(`
          workspace_id, created_at,
          workspaces (id, name, agency_name, logo_storage_path, plan_tier, deleted_at, onboarding_completed_at)
        `)
        .eq('user_id', user.id)
        .eq('status', 'active')
        .order('created_at', { ascending: true }),
      (service as any)
        .from('users').select('active_workspace_id, deleted_at').eq('id', user.id).maybeSingle(),
    ])

    if (userRow?.deleted_at) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const alive = (memberships || []).filter((m: any) => m.workspaces && !m.workspaces.deleted_at)

    // FIX (Workspace lifecycle independent pass, round 20): `active` used to be a
    // direct `w.id === userRow?.active_workspace_id` check against the raw column.
    // deactivate_member_atomic (migration 070, DELETE /api/team/[id] — Team &
    // Invites, traced into this section) never reassigns a removed member's
    // active_workspace_id the way leave_workspace_atomic and workspace/delete's own
    // reassignment loop do (onboarding-status/route.ts already hit this exact
    // staleness and works around it — this route was the one place missed). Someone
    // removed from what was their active workspace saw NO workspace marked active
    // here, even though they still have other perfectly good active memberships —
    // and since the sidebar's "Leave" button is gated on `!active`, their REAL
    // current workspace (correctly resolved server-side by getSession's own
    // fallback) looked exactly as leaveable as every other entry, with nothing to
    // set it apart. Resolve the same way getSession()/onboarding-status do: prefer
    // active_workspace_id when it resolves within this user's own alive
    // memberships, else pick the same fallback (oldest, preferring a completed
    // workspace) they'd land on.
    const activeMatch = alive.find((m: any) => m.workspace_id === userRow?.active_workspace_id)
    const resolvedActiveId = (activeMatch || pickFallbackMembership(alive))?.workspace_id ?? null

    const workspaces = alive.map((m: any) => {
      const w = m.workspaces
      return {
        id:         w.id,
        name:       w.name,
        agencyName: w.agency_name,
        logoUrl:    w.logo_storage_path
          ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/logos/${w.logo_storage_path}`
          : null,
        planTier:   w.plan_tier,
        active:     w.id === resolvedActiveId,
        // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
        // list is also used by the onboarding wizard's exit panel to offer
        // "switch to a workspace you already set up" — without this flag
        // it couldn't tell that promise apart from another of the user's
        // own INCOMPLETE workspaces (migration 019's grandfather clause
        // proves having more than one at once is a real, if rare,
        // possibility), silently sending them into a switch-then-bounce-
        // back-to-/onboarding loop for the wrong workspace instead.
        onboardingComplete: !!w.onboarding_completed_at,
      }
    })

    return NextResponse.json({ workspaces })
  } catch (err) {
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): raw
    // exception message was returned straight to the client — same
    // info-disclosure pattern already fixed elsewhere in this section.
    console.error('Workspace list error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
