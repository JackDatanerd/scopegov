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

    const { workspaceId } = await request.json()
    if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

    const service = createServiceClient()

    // Must actually be an active member of the target workspace.
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
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
