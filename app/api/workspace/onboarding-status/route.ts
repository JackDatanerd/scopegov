// app/api/workspace/onboarding-status/route.ts
//
// FIX (deep audit, Workspace lifecycle + Onboarding sections — headline
// finding): app/onboarding/page.tsx used to have zero awareness of why it
// was being visited — it only ever checked its own per-user localStorage
// for an in-progress workspaceId, and if that was empty, unconditionally
// called POST /api/workspace/create to start a brand-new workspace.
//
// But the onboarding wizard's own Step 3 ("Invite a team member") fires a
// REAL POST /api/team/invite before the wizard's own complete() call ever
// runs — so it's entirely normal for a workspace to have an outstanding
// invite while onboarding_completed_at is still null (the inviter just
// hasn't clicked "Done" yet). Both invite-acceptance routes
// (team/invite/[token]/accept and .../signup) then unconditionally set the
// accepting user's active_workspace_id to that workspace. On their very
// next page load, middleware correctly sees their active workspace hasn't
// completed onboarding and sends them to /onboarding — but
// complete-onboarding is scoped to `created_by = user.id`, so the invited
// person can never finish it, and the onboarding page (having no local
// progress of its own) would just spin up an entirely new, unrelated
// workspace for them instead, permanently stranding their real invited
// membership in a half-set-up state with no way back to it.
//
// This endpoint gives the onboarding page what it needs to tell the three
// situations apart before it decides what to render:
//   - 'create'  — no incomplete workspace at all (or none reachable):
//                 normal new-user flow.
//   - 'resume'  — the caller is the CREATOR of an incomplete workspace:
//                 resume the wizard for it (works even without localStorage,
//                 e.g. a new device or cleared browser data).
//   - 'waiting' — the caller is an ordinary member (not the creator) of an
//                 incomplete workspace: show a waiting screen instead of
//                 ever creating a second workspace on their behalf.
//   - 'complete' — every active membership is already onboarded (direct
//                 nav to /onboarding after the fact): send them onward.

import { createServiceClient, createServerSupabaseClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    const [{ data: userRow }, { data: memberships }] = await Promise.all([
      (service as any).from('users').select('active_workspace_id').eq('id', user.id).maybeSingle(),
      (service as any)
        .from('workspace_members')
        .select('workspace_id, workspaces(id, created_by, onboarding_completed_at, name, agency_name, industry, currency, timezone, creator:users!workspaces_created_by_fkey(name, email))')
        .eq('user_id', user.id).eq('status', 'active'),
    ])

    const active = (memberships || []).filter((m: any) => m.workspaces)
    const activeWorkspaceId = userRow?.active_workspace_id

    const ownedIncomplete   = active.filter((m: any) => m.workspaces.created_by === user.id && !m.workspaces.onboarding_completed_at)
    const memberIncomplete  = active.filter((m: any) => m.workspaces.created_by !== user.id && !m.workspaces.onboarding_completed_at)

    // Prefer whichever incomplete workspace is currently active, else the
    // first one found — mirrors lib/auth/session.ts's own
    // active-with-fallback-to-oldest resolution order.
    const pick = (list: any[]) => list.find((m: any) => m.workspace_id === activeWorkspaceId) || list[0]

    if (ownedIncomplete.length > 0) {
      const m = pick(ownedIncomplete)
      const w = m.workspaces
      return NextResponse.json({
        status: 'resume',
        workspaceId: w.id,
        agencyName: w.agency_name || w.name || '',
        industry: w.industry || '',
        currency: w.currency || 'USD',
        timezone: w.timezone || 'America/New_York',
      })
    }

    if (memberIncomplete.length > 0) {
      const m = pick(memberIncomplete)
      const w = m.workspaces
      return NextResponse.json({
        status: 'waiting',
        agencyName: w.agency_name || w.name || '',
        creatorName: w.creator?.name || w.creator?.email || 'the person who created it',
      })
    }

    if (active.length > 0) return NextResponse.json({ status: 'complete' })

    return NextResponse.json({ status: 'create' })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
