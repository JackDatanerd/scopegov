import { createServerSupabaseClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// FIX (deep audit, Auth+MFA independent re-pass): supabase-js defaults
// signOut() to `scope: 'global'`, which revokes EVERY session for this
// user, not just this browser — the exact bug already found and fixed on
// Sidebar.tsx's everyday "Sign out" button (see its own comment for the
// full rationale: a routine logout shouldn't be as aggressive as the
// dedicated "sign out of other sessions" feature). This route is the one
// place that fix never reached — it's the only remaining caller left
// (mfa-challenge/page.tsx's "Sign out" link, for someone backing out of a
// login attempt on one device), and it was still silently signing the
// user out of their phone/other browser/other tab too. reset-password and
// change-password intentionally rely on the global default elsewhere for
// a real security reason (invalidate everywhere after a password change)
// — this action never had that rationale.
export async function POST() {
  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut({ scope: 'local' })
  return NextResponse.json({ ok: true })
}
