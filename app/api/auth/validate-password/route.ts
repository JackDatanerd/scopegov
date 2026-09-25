export const runtime = 'nodejs'

import { NextResponse } from 'next/server'

// RETIRED (Auth+MFA re-pass, follow-up). This endpoint was only ever an
// advisory pre-check the sign-up page called before handing the password
// to supabase.auth.signUp() in the browser — see the git history on this
// file for the original comment explaining why. That was never an
// authoritative gate: nothing stopped a direct supabase.auth.signUp() call
// (trivial with the public anon key) from skipping this endpoint entirely
// and creating an account with a common password, an email-matching
// password, or one over the 72-byte bcrypt cap.
//
// Sign-up itself now runs server-side via POST /api/auth/signup, which
// calls validatePassword() directly before the account is created — the
// same authoritative pattern change-password, reset-password, and
// invite-signup already used. Nothing calls this route any more; it
// answers 410 so a signup page loaded before the deploy fails harmlessly
// instead of silently no-op'ing. Safe to delete this file.
export async function POST() {
  return NextResponse.json({ error: 'This endpoint has been retired.' }, { status: 410 })
}
