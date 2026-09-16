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

async function buildResumePayload(service: any, w: any) {
  // FIX (round 3, Onboarding Finding 2 — severe): this response used to
  // return only step-0 fields (agencyName/industry/currency/timezone).
  // app/onboarding/page.tsx's resume handler always hardcodes step 1 on
  // resume, so a user who'd already saved real branding or SOW defaults
  // in an earlier session (then switched devices, or cleared
  // localStorage) came back to the wizard's hardcoded step-1 defaults
  // (#1A5C3A, 2 revision rounds, 50/50) with no idea their real settings
  // weren't showing — and clicking Continue through steps 1-2 again
  // silently overwrote the real saved values with those defaults, since
  // submitBranding/submitDefaults always PATCH/POST whatever's currently
  // in state. Fetch and return what's already saved so the wizard can
  // rehydrate its fields instead of reintroducing the defaults.
  const { data: defaultsRow } = await service
    .from('workspace_defaults')
    .select('revision_rounds, payment_structure')
    .eq('workspace_id', w.id).is('project_type', null).maybeSingle()

  return {
    status: 'resume',
    workspaceId: w.id,
    agencyName: w.agency_name || w.name || '',
    industry: w.industry || '',
    currency: w.currency || 'USD',
    timezone: w.timezone || 'America/New_York',
    brandColour: w.brand_colour || null,
    logoStoragePath: w.logo_storage_path || null,
    governingLaw: w.governing_law || '',
    revisionRounds: defaultsRow?.revision_rounds != null ? String(defaultsRow.revision_rounds) : '2',
    paymentStructure: defaultsRow?.payment_structure || '50_50',
  }
}

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
        .select(`workspace_id, workspaces(
          id, created_by, onboarding_completed_at, name, agency_name, industry, currency, timezone,
          brand_colour, logo_storage_path, governing_law,
          creator:users!workspaces_created_by_fkey(name, email)
        )`)
        .eq('user_id', user.id).eq('status', 'active')
        // FIX (Workspace lifecycle + Onboarding, round 4): ownedIncomplete[0]
        // and memberIncomplete[0] below have no defined order without this —
        // migration 019's own grandfather clause (trial_cap_exempt) proves a
        // user CAN legitimately have more than one owned incomplete
        // workspace at once, and Postgres gives no ordering guarantee absent
        // an ORDER BY. Which abandoned workspace gets resumed could vary
        // request to request. Oldest first, matching the same tie-break
        // lib/auth/session.ts and leave_workspace_atomic already use.
        .order('created_at', { ascending: true }),
    ])

    const active = (memberships || []).filter((m: any) => m.workspaces)
    const activeWorkspaceId = userRow?.active_workspace_id

    const ownedIncomplete   = active.filter((m: any) => m.workspaces.created_by === user.id && !m.workspaces.onboarding_completed_at)
    const memberIncomplete  = active.filter((m: any) => m.workspaces.created_by !== user.id && !m.workspaces.onboarding_completed_at)

    // FIX (round 3, Workspace lifecycle Finding 6): this used to check
    // ownedIncomplete unconditionally before ever looking at
    // memberIncomplete, then only used `activeWorkspaceId` to pick WITHIN
    // whichever list won — contradicting its own comment ("prefer
    // whichever incomplete workspace is currently active"). A user whose
    // ACTIVE workspace was one they're waiting on as an invited member,
    // but who also has some unrelated abandoned workspace they once
    // created, got forced into 'resume' mode for the wrong (irrelevant,
    // not-currently-active) workspace instead of 'waiting' for the one
    // they're actually trying to use. Check the active workspace's own
    // incompleteness FIRST, across both lists, before falling back to
    // "first owned, else first member" for the case where the active
    // workspace itself is fully onboarded (or there is no active pick).
    const activeIncomplete = active.find((m: any) => m.workspace_id === activeWorkspaceId && !m.workspaces.onboarding_completed_at)

    if (activeIncomplete) {
      const w = activeIncomplete.workspaces
      if (w.created_by === user.id) {
        return NextResponse.json(await buildResumePayload(service, w))
      }
      return NextResponse.json({
        status: 'waiting',
        agencyName: w.agency_name || w.name || '',
        creatorName: w.creator?.name || w.creator?.email || 'the person who created it',
      })
    }

    if (ownedIncomplete.length > 0) {
      const w = ownedIncomplete[0].workspaces
      return NextResponse.json(await buildResumePayload(service, w))
    }

    if (memberIncomplete.length > 0) {
      const w = memberIncomplete[0].workspaces
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
