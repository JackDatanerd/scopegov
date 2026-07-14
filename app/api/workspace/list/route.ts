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
          workspaces (id, name, agency_name, logo_storage_path, plan_tier, deleted_at)
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
      }))

    return NextResponse.json({ workspaces })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
