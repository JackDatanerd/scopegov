// app/api/workspace/list/route.ts
//
// Lists every workspace the current user is an active member of, for the
// workspace switcher dropdown. This is what makes multi-workspace visible —
// getSession() only ever loads ONE workspace (the active one); this route
// is how the UI finds out there are others.

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    const [{ data: memberships }, { data: userRow }] = await Promise.all([
      (service as any)
        .from('workspace_members')
        .select(`
          workspace_id,
          workspaces (id, name, agency_name, logo_storage_path, plan_tier, deleted_at, onboarding_completed_at)
        `)
        .eq('user_id', user.id)
        .eq('status', 'active'),
      (service as any)
        .from('users').select('active_workspace_id').eq('id', user.id).maybeSingle(),
    ])

    const workspaces = (memberships || [])
      .map((m: any) => m.workspaces)
      .filter((w: any) => w && !w.deleted_at)
      .map((w: any) => ({
        id:         w.id,
        name:       w.name,
        agencyName: w.agency_name,
        logoUrl:    w.logo_storage_path
          ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/logos/${w.logo_storage_path}`
          : null,
        planTier:   w.plan_tier,
        active:     w.id === userRow?.active_workspace_id,
        // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
        // list is also used by the onboarding wizard's exit panel to offer
        // "switch to a workspace you already set up" — without this flag
        // it couldn't tell that promise apart from another of the user's
        // own INCOMPLETE workspaces (migration 019's grandfather clause
        // proves having more than one at once is a real, if rare,
        // possibility), silently sending them into a switch-then-bounce-
        // back-to-/onboarding loop for the wrong workspace instead.
        onboardingComplete: !!w.onboarding_completed_at,
      }))

    return NextResponse.json({ workspaces })
  } catch (err) {
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): raw
    // exception message was returned straight to the client — same
    // info-disclosure pattern already fixed elsewhere in this section.
    console.error('Workspace list error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
