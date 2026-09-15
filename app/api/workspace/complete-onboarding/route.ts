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

    // FIX (section-by-section re-audit, Workspace lifecycle Finding 4):
    // Supabase resolves `error: null` even when the filter matches zero
    // rows — a stale/mistyped workspaceId, or one that doesn't belong to
    // this user, silently no-op'd and still returned { ok: true }.
    // middleware.ts gates every non-API route on
    // workspace.onboarding_completed_at, so a false-success response
    // here stranded the user in a redirect loop back to /onboarding with
    // no error ever surfaced. Chain .select().maybeSingle() so we can
    // tell whether a row actually changed.
    const { data: updated, error } = await (service as any)
      .from('workspaces')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', workspaceId)
      .eq('created_by', user.id)
      .select('id')
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!updated) return NextResponse.json({ error: 'Workspace not found, or you don\u2019t have permission to complete onboarding for it.' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
