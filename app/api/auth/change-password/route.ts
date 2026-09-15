export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { permissionsRequireMfa } from '@/lib/auth/mfa-policy'

// FIX (deep audit, section 5): password changes used to go straight from
// the browser to `supabase.auth.updateUser({ password })` with no backend
// route at all. Disabling MFA on this same account requires proving aal2
// in-session first (see app/api/auth/mfa/factors/route.ts) precisely
// because a hijacked/idle session cookie shouldn't be enough to strip a
// mandatory security control off an account — but changing the password,
// an equally account-taking-over-capable action, had no equivalent check
// anywhere. This route restores that parity: same aal2 rule, only when
// the caller's current role actually mandates MFA.
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { password } = await request.json().catch(() => ({}))
    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    const service = createServiceClient()
    const { data: userRow } = await (service as any)
      .from('users').select('active_workspace_id').eq('id', user.id).maybeSingle()

    let mandatory = false
    if (userRow?.active_workspace_id) {
      const { data: memberRow } = await (service as any)
        .from('workspace_members').select('effective_permissions')
        .eq('user_id', user.id).eq('workspace_id', userRow.active_workspace_id)
        .eq('status', 'active').maybeSingle()
      mandatory = permissionsRequireMfa(memberRow?.effective_permissions)
    }

    if (mandatory) {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal?.currentLevel !== 'aal2') {
        return NextResponse.json({
          error: 'Re-verify your authenticator code before changing your password.',
        }, { status: 403 })
      }
    }

    const { error } = await supabase.auth.updateUser({ password })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
