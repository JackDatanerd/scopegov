// app/api/workspace/switch/route.ts
//
// Sets the user's active_workspace_id, which getSession() now actually
// respects (see lib/auth/session.ts). Always verifies the user is really
// an active member of the target workspace first — never trust a
// client-supplied workspace ID without checking membership, since this
// would otherwise let anyone "switch into" any workspace by ID.

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    // FIX (Workspace lifecycle independent pass, round 20): same gap as
    // workspace/create's own already-fixed finding — this route authenticates with
    // getUser() alone, with no users.deleted_at check, and middleware.ts explicitly
    // never checks it for API routes ("API routes enforce their own workspace
    // checks via getSession()"). Self-service account/delete already leaves every
    // workspace before marking deleted_at, so it's self-defended here in practice —
    // but admin_suspend deliberately leaves workspace_members untouched while
    // banning the auth user, so a suspended person could otherwise still switch
    // their active workspace for as long as their already-issued access token
    // stays valid. Checked explicitly rather than relying on that side effect.
    const { data: deletedCheck } = await (service as any)
      .from('users').select('deleted_at').eq('id', user.id).maybeSingle()
    if (deletedCheck?.deleted_at) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // FIX (workspace lifecycle independent pass, W2): an unparseable / non-object body threw into the 500 catch-all.
    const reqBody = await request.json().catch(() => null)
    const workspaceId = typeof reqBody?.workspaceId === 'string' ? reqBody.workspaceId : ''
    if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

    // Must actually be an active member of the target workspace.
    //
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
    // defense in depth): session.ts, middleware.ts, onboarding-status,
    // and workspace/list were all explicitly hardened against a stray
    // active `workspace_members` row pointing at a soft-deleted
    // workspace — this route, the one place that actually WRITES
    // active_workspace_id off a client-supplied id, was the one missed
    // in that sweep. Join deleted_at and refuse it here too, same as
    // everywhere else.
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id, workspaces!inner(deleted_at)')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .is('workspaces.deleted_at', null)
      .maybeSingle()

    if (!member) return NextResponse.json({ error: 'Not a member of that workspace' }, { status: 403 })

    const { error } = await (service as any)
      .from('users')
      .update({ active_workspace_id: workspaceId })
      .eq('id', user.id)

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
    // used to `throw new Error(error.message)`, which the catch-all below
    // then returned to the client verbatim — actively funneling a raw
    // Postgres error message straight through, the exact info-disclosure
    // pattern already fixed for every other write in this section. Log
    // server-side and return a generic message directly instead.
    if (error) {
      console.error('Workspace switch update failed:', error)
      return NextResponse.json({ error: 'Could not switch workspaces. Try again.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Workspace switch error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
