import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { sharedCookieOptions, domainScopedCookieOptions } from './cookie-options'

// ── Server component / Route Handler client (respects RLS via session) ────
export async function createServerSupabaseClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: sharedCookieOptions(),
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              // FIX (deep audit, Auth+MFA independent re-pass): only the
              // code_verifier cookie needs the wide domain — see
              // domainScopedCookieOptions()'s own comment. Every other
              // cookie (the session/refresh token included) gets set
              // host-only.
              cookieStore.set(name, value, domainScopedCookieOptions(name, options) as CookieOptions)
            )
          } catch {
            // setAll called from a Server Component — cookies are read-only
          }
        },
      },
    }
  )
}

// ── Service role client (bypasses RLS — use for admin operations) ─────────
export function createServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// ── Stateless auth-only client (deep audit, Auth+MFA re-pass) ─────────────
// For verifying a credential (e.g. "confirm your current password before
// changing it") without disturbing the caller's real, cookie-backed
// session. Built directly with the anon key via plain @supabase/supabase-js
// — no @supabase/ssr cookie adapter at all, so a signInWithPassword() call
// against this client can never read or overwrite the request's actual
// session cookies, and persistSession/autoRefreshToken are both off so it
// discards whatever session it creates the moment this client falls out of
// scope. Anon key, not service role — this only ever asks GoTrue "is this
// email+password combination valid," the same privilege level a real login
// attempt has.
//
// FIX (Auth+MFA fresh audit — LOW/MEDIUM): every call through this client mints a real
// auth.sessions row, and the sign-in audit trigger (migration 068) logged each one as
// `security.login_succeeded` — so every current-password check in change-password /
// step-up put a login that never happened (from the server's egress IP) into every
// audit log. The client now identifies itself with CREDENTIAL_CHECK_USER_AGENT and
// migration 115 makes the trigger skip sessions carrying it.
export const CREDENTIAL_CHECK_USER_AGENT = 'ScopeGov-CredentialCheck/1'

export function createStatelessAuthClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { 'User-Agent': CREDENTIAL_CHECK_USER_AGENT } },
    }
  )
}
