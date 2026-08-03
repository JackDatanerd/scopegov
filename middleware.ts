import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { sharedCookieOptions } from './lib/supabase/cookie-options'
import { permissionsRequireMfa } from './lib/auth/mfa-policy'

export async function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  const refCode = searchParams.get('ref')

  // ── Build a mutable response ─────────────────────────────────────────────
  let response = NextResponse.next({ request })

  // ── Capture referral cookie on every path ─────────────────────────────────
  // BUG-009 carry-forward §9: attach to EVERY response path
  const existingRef = request.cookies.get('ss_ref')?.value
  function withRef<T extends NextResponse>(res: T): T {
    if (refCode && !existingRef) {
      res.cookies.set('ss_ref', refCode, {
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
      })
    }
    return res
  }

  // ── Supabase client that reads/writes cookies on this request ─────────────
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: sharedCookieOptions(),
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value)
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  // Refresh session — required by @supabase/ssr
  const { data: { user } } = await supabase.auth.getUser()

  const isAuthRoute = pathname.startsWith('/login') ||
    pathname.startsWith('/signup') ||
    pathname.startsWith('/reset-password') ||
    pathname.startsWith('/verify-email') ||
    pathname.startsWith('/forgot-password')

  const isPublicRoute =
    pathname.startsWith('/portal/') ||
    pathname.startsWith('/invite/') ||
    // BUG: the pages above were public but the APIs behind them were not.
    // An unauthenticated visitor's fetch('/api/portal/...') or
    // fetch('/api/team/invite/{token}') was silently redirected to /login
    // (HTML, not JSON) by the block below — breaking SOW signing, CO
    // responses, and invite acceptance for every real, logged-out recipient.
    // Trailing slash on '/api/team/invite/' deliberately excludes the bare
    // POST /api/team/invite (create) endpoint, which still requires auth.
    pathname.startsWith('/api/portal/') ||
    pathname.startsWith('/api/team/invite/') ||
    // BUG: /api/auth/callback exchanges a signup-confirmation/OAuth/recovery
    // code for a session — the request is *by definition* unauthenticated
    // when it arrives. It was being redirected to /login before the route
    // handler ever ran, breaking every fresh email signup and OAuth login.
    pathname.startsWith('/api/auth/callback') ||
    pathname.startsWith('/api/guardian/inbound') ||
    pathname.startsWith('/api/billing/webhook') ||
    pathname.startsWith('/api/cron/') ||
    pathname === '/'

  const isOnboarding = pathname === '/onboarding'

  // Routes for the MFA challenge/setup flows themselves, plus the handful
  // of auth endpoints a partially-authenticated (aal1-only) user must
  // still be able to reach — sign out, and the mfa API namespace that
  // powers the /mfa-challenge and /mfa-setup pages.
  const isMfaFlowRoute =
    pathname.startsWith('/mfa-challenge') ||
    pathname.startsWith('/mfa-setup') ||
    pathname.startsWith('/api/auth/mfa/') ||
    pathname.startsWith('/api/auth/signout')

  // ── Not authenticated → redirect to login ─────────────────────────────────
  if (!user && !isAuthRoute && !isPublicRoute && !isOnboarding) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return withRef(NextResponse.redirect(loginUrl))
  }

  // ── Authenticated, but MFA challenge not yet completed this session ──────
  // AAL is read straight off the session's JWT claims (no network round
  // trip), so this check is cheap on every request. currentLevel === aal1
  // with nextLevel === aal2 means: this user has a verified TOTP factor,
  // but hasn't entered a code yet in this particular session — e.g. they
  // just signed in with a password, or an old session cookie survived
  // from before enrollment. Supabase's own guidance is to route these
  // users to a challenge screen rather than hard-401 them, since it's a
  // routine, expected state (not necessarily an attack) — but note this
  // still runs for /api/* routes below, just returning JSON instead of a
  // redirect, because a stolen session cookie without the authenticator
  // app must not be enough to read data through the API either.
  if (user && !isPublicRoute && !isMfaFlowRoute) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal2') {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Two-factor verification required.' }, { status: 401 })
      }
      const url = new URL('/mfa-challenge', request.url)
      url.searchParams.set('next', pathname)
      return withRef(NextResponse.redirect(url))
    }
  }

  // ── Authenticated → redirect away from auth pages ─────────────────────────
  // BUG (password reset): /reset-password is intentionally reachable with an
  // authenticated session — clicking a recovery link signs the user in via a
  // temporary session so they can set a new password. This block used to
  // treat that as "already logged in" and bounce them to /dashboard or
  // /onboarding before they ever saw the reset form. Exclude it here.
  if (user && isAuthRoute && pathname !== '/reset-password') {
    // Check if they have a workspace before sending to dashboard
    const { data: member } = await (supabase as any)
      .from('workspace_members')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .limit(1)
      .single()

    const dest = member ? '/dashboard' : '/onboarding'
    return withRef(NextResponse.redirect(new URL(dest, request.url)))
  }

  // ── Authenticated → check onboarding ─────────────────────────────────────
  // BUG-001: onboarding page is OUTSIDE (app)/ group to prevent redirect loops
  if (user && !isOnboarding && !isPublicRoute && !isAuthRoute) {
    // We check onboarding status via the workspace — only for non-API routes
    if (!pathname.startsWith('/api/')) {
      const { data: member } = await (supabase as any)
        .from('workspace_members')
        .select('workspace:workspaces(onboarding_completed_at)')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(1)
        .single()

      // No workspace_members row at all → user signed up but never completed
      // onboarding. Redirect to /onboarding instead of falling through to the
      // app (which would call getSession() → null → redirect to /login → loop).
      if (!member) {
        return withRef(NextResponse.redirect(new URL('/onboarding', request.url)))
      }

      if (member && !member.workspace?.onboarding_completed_at) {
        if (pathname !== '/onboarding') {
          return withRef(NextResponse.redirect(new URL('/onboarding', request.url)))
        }
      }
    }
  }

  // ── Authenticated, onboarded → forced MFA enrollment for governance roles ──
  // Only reached once we already know the challenge-pending case above
  // doesn't apply, so aal here is either "aal2" (already enrolled and
  // verified — nothing to do) or "aal1/aal1" (zero verified factors at
  // all). We only pay for the extra permissions query in the latter case.
  // Deliberately checked at the *page* level, not per-API-route: this is
  // an enrollment nudge with teeth (you cannot reach any page of the
  // product without it), not a per-request authorization boundary — the
  // aal1→aal2 block above already covers the "already enrolled but not
  // verified this session" security boundary for both pages and APIs.
  if (
    user && !isPublicRoute && !isMfaFlowRoute && !isAuthRoute && !isOnboarding &&
    !pathname.startsWith('/api/')
  ) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal1') {
      const { data: memberships } = await (supabase as any)
        .from('workspace_members')
        .select('effective_permissions')
        .eq('user_id', user.id)
        .eq('status', 'active')

      const mustEnroll = (memberships || []).some((m: any) => permissionsRequireMfa(m.effective_permissions))
      if (mustEnroll) {
        return withRef(NextResponse.redirect(new URL('/mfa-setup', request.url)))
      }
    }
  }

  return withRef(response)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static, _next/image (Next.js internals)
     * - favicon.ico, robots.txt
     * - Public assets
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
