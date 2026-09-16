import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { name: nameRaw } = await request.json()
    if (!nameRaw?.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 })
    // FIX (deep audit, Workspace lifecycle section): was a bare .trim() —
    // no length cap, no control-character stripping — unlike the sibling
    // agencyName field in workspace/create and workspace/settings, which
    // both use sanitizeDisplayName for exactly this reason: this value
    // (session.name) flows into audit_log actorName on nearly every
    // mutating route, notification titles, and email greetings across
    // the app, unescaped and unbounded until now.
    const name = sanitizeDisplayName(nameRaw)
    if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 })

    const service = createServiceClient()
    // FIX (section-by-section re-audit): unchecked write, same false-
    // success shape as complete-onboarding — now checked and surfaced.
    const { error } = await (service as any).from('users')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', session.id)
    // FIX (Workspace lifecycle, round 4): raw Postgres error.message was
    // returned straight to the client — the exact info-disclosure pattern
    // workspace/create's own Finding comment already flagged and fixed
    // for itself, missed here. Log server-side only, return a generic
    // message like every other route in this section does.
    if (error) {
      console.error('Profile name update failed:', error)
      return NextResponse.json({ error: 'Failed to update name' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
