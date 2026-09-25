// FIX (deep audit, Auth+MFA re-pass — signup password-policy bypass):
// account creation used to happen via supabase.auth.signUp() called
// directly from the browser (app/(auth)/signup/page.tsx), with
// /api/auth/validate-password as an advisory, unauthoritative check the
// page happened to call first. Nothing stopped a direct call to
// supabase.auth.signUp() with the public anon key from skipping that
// check entirely and creating a real account with a common password, a
// password matching the account's own email, or one over the 72-byte
// bcrypt cap — every other password-setting path in this app
// (change-password, reset-password, invite-signup) enforces this
// authoritatively because the account/password write happens server-side.
// This route moves public sign-up itself server-side so the same is true
// here: validatePassword() is the actual gate, not a UI nicety the caller
// can route around.
//
// Behavior is otherwise unchanged from the old client-side flow: the same
// enumeration-safe "already registered" handling (matches forgot-
// password's "identical response regardless" principle), the same
// terms_version stamping (handle_new_user, migration 064, records it with
// a server timestamp — the client never supplies the acceptance time),
// the same emailRedirectTo callback destination, and the same name-length
// cap — now via sanitizeDisplayName, matching invite-signup's own
// convention, and stricter (it also strips control/newline characters).
// Google sign-up is untouched: it never went through
// supabase.auth.signUp() and never had this gap.
//
// Uses createServerSupabaseClient() (not the stateless anon client) on
// purpose: it's cookie-bound, so if this Supabase project ever has email
// confirmations disabled, the session signUp() returns is persisted onto
// the response via Set-Cookie the same way any other sign-in would be —
// the normal case (confirmation required, no session yet) just writes no
// cookies, matching today's behavior.

import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { validatePassword } from '@/lib/auth/password-policy'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { TERMS_VERSION } from '@/lib/auth/terms'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object')
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    const { email, password } = body as Record<string, unknown>
    const rawName = (body as Record<string, unknown>).name

    if (typeof email !== 'string' || !email.trim())
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })

    const name = sanitizeDisplayName(typeof rawName === 'string' ? rawName : '')
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

    const policyError = validatePassword(password, { email })
    if (policyError) return NextResponse.json({ error: policyError }, { status: 400 })

    const supabase = await createServerSupabaseClient()
    const { data, error: err } = await supabase.auth.signUp({
      email: email.trim(),
      password: password as string,
      options: {
        data: { name, terms_version: TERMS_VERSION },
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback?next=/onboarding`,
      },
    })

    if (err) {
      // Enumeration-safe: an "already registered" error is treated exactly
      // like a successful signup from the outside. Supabase itself doesn't
      // re-send a confirmation email to an already-confirmed address, so
      // the real account holder isn't spammed — probing an email address
      // via signup no longer confirms whether it's in use.
      if (err.message.toLowerCase().includes('already registered'))
        return NextResponse.json({ ok: true, emailSent: true })
      return NextResponse.json({ error: err.message }, { status: 400 })
    }

    return NextResponse.json({ ok: true, emailSent: !data.session })
  } catch (err) {
    console.error('Signup error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
