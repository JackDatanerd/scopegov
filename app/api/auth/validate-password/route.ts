import { NextResponse, type NextRequest } from 'next/server'
import { validatePassword } from '@/lib/auth/password-policy'

// FIX (deep audit, Auth+MFA section — signup password-policy bypass): the
// public sign-up page (app/(auth)/signup/page.tsx) calls
// supabase.auth.signUp() straight from the browser, so it never runs
// through any of this app's own API routes. lib/auth/password-policy.ts
// (the common-password blocklist, the email-match check, the 72-byte
// bcrypt cap) is wired into change-password, reset-password, and the
// invite-signup route — every OTHER place a new password is set — but was
// never reachable from the single biggest password-creation entry point.
// A brand-new account could be created with "password123" or a 100+ byte
// password (silently truncated by bcrypt) with zero pushback beyond the
// client's bare `length < 8` check.
//
// validatePassword() itself can't run in the browser (it uses Node's
// Buffer for the byte-length check), so this is a small, unauthenticated,
// side-effect-free endpoint the sign-up page calls before handing the
// password to supabase.auth.signUp() — deliberately NOT folded into a
// bigger "create the account server-side" rewrite, so the existing
// session/email-verification/Google-OAuth behavior of that page is left
// exactly as it is. Nothing here touches the database or an existing
// account, so there's no credential to brute-force and no rate limit
// needed — it only ever checks the caller's own input against a public
// rule set.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const password = body?.password
  const email = typeof body?.email === 'string' ? body.email : undefined

  const error = validatePassword(password, { email })
  return NextResponse.json({ error })
}
