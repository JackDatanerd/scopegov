import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { sharedCookieOptions, domainScopedCookieOptions } from './lib/supabase/cookie-options'
import { MFA_REQUIRED_PERMISSIONS } from './lib/auth/mfa-policy'

// State the middleware needs about the signed-in user, from ONE SECURITY DEFINER
// RPC (migration 064). Replaces five session-bound reads of `workspace_members`
// that migration 041's REVOKE had made fail with "permission denied" — which
// bounced every onboarded user into a /dashboard <-> /onboarding redirect loop
// and made the forced-MFA-enrolment check fail open.
interface GateState {
  deleted: boolean
  has_workspace: boolean
  onboarding_complete: boolean
  must_enroll_mfa: boolean
}

export async function middleware(request: NextRequest) {
  const { pathname, searchParams, search } = request.nextUrl
  const isApi = pathname.startsWith('/api/')
  const refCode = searchParams.get('ref')

  // Create a response we can attach refreshed session cookies to.
  //
  // FIX (Auth+MFA audit round 2): this used to be a `const` built ONCE, before
  // supabase ran. NextResponse.next({ request }) snapshots the request headers
  // at construction, so when getUser() refreshed the session and setAll() wrote
  // the rotated tokens onto `request.cookies`, the route handler / Server
  // Component running after this middleware STILL received the old cookies — it
  // then refreshed AGAIN with a refresh token the middleware had just consumed,
  // surviving only inside GoTrue's reuse window (and failing outright where that
  // is set to 0). setAll() now REBUILDS the response so downstream code sees the
  // fresh session, and every rotated cookie is re-applied to the new response.
  let response = NextResponse.next({ request })
  const rotatedCookies = new Map<string, { value: string; options: CookieOptions }>()

  const existingRef = request.cookies.get('ss_ref')?.value

  // Every return path goes through finalize():
  //  - attribution cookie (first-touch ?ref=)
  //  - the session cookies supabase just refreshed. FIX (build — Auth
  //    independent audit): redirects and 401 JSON responses used to be
  //    returned as fresh responses WITHOUT the rotated tokens setAll() had
  //    written to `response`, so a refresh that happened on a request that then
  //    redirected was lost and the browser kept re-presenting the consumed
  //    refresh token (only saved by GoTrue's 10s reuse window).
  //  - expiry of legacy `Domain=` session cookies (see below).
  const legacyCookieNames = duplicatedSessionCookieNames(request)
  function finalize<T extends NextResponse>(res: T): T {
    if (res !== (response as NextResponse)) {
      response.cookies.getAll().forEach(c => res.cookies.set(c))
    }
    if (refCode && !existingRef) {
      res.cookies.set('ss_ref', refCode.slice(0, 64), {
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      })
    }
    // Appended raw AFTER every cookies.set() (ResponseCookies is keyed by name
    // and would collapse this with the host-only cookie of the same name).
    const domain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN
    if (domain) {
      for (const name of legacyCookieNames) {
        res.headers.append(
          'Set-Cookie',
          `${name}=; Path=/; Domain=${domain}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax`
        )
      }
    }
    return res
  }

  function unavailable(): NextResponse {
    const headers = { 'Retry-After': '5' }
    return isApi
      ? NextResponse.json({ error: 'Service temporarily unavailable. Please retry.' }, { status: 503, headers })
      : new NextResponse('Service temporarily unavailable. Please retry in a moment.', { status: 503, headers })
  }

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
            rotatedCookies.set(name, { value, options: domainScopedCookieOptions(name, options) as CookieOptions })
          })
          response = NextResponse.next({ request })
          rotatedCookies.forEach(({ value, options }, name) => response.cookies.set(name, value, options))
        },
      },
    }
  )

  // Validates the JWT with Supabase Auth (and refreshes it when near expiry).
  const { data: { user } } = await supabase.auth.getUser()

  const isAuthRoute = pathname.startsWith('/login') ||
    pathname.startsWith('/signup') ||
    pathname.startsWith('/reset-password') ||
    pathname.startsWith('/forgot-password')

  const isPublicRoute =
    pathname.startsWith('/portal/') ||
    pathname.startsWith('/invite/') ||
    pathname.startsWith('/legal/') ||
    pathname.startsWith('/api/portal/') ||
    pathname.startsWith('/api/team/invite/') ||
    pathname.startsWith('/api/auth/callback') ||
    pathname.startsWith('/api/guardian/inbound') ||
    pathname.startsWith('/api/billing/webhook') ||
    // Resend delivery webhook — authenticated by its Svix signature, not a session.
    pathname.startsWith('/api/webhooks/resend') ||
    pathname.startsWith('/api/cron/') ||
    pathname === '/'

  const isOnboarding = pathname === '/onboarding'
  // FIX (Auth+MFA audit round 2 — HIGH): the moment /api/workspace/create returns,
  // the creator is an Owner — an MFA-mandatory role — and the enrolment gate below
  // starts refusing every API call that isn't an MFA route. The onboarding wizard
  // still has to save branding, defaults, invites and finally
  // /api/workspace/complete-onboarding, so EVERY new workspace owner was stranded
  // on step 1 with "Two-factor enrollment required" and no link to /mfa-setup
  // (only the /onboarding PAGE was exempt, not the calls it makes). While
  // onboarding is unfinished these — and only these — API routes stay reachable;
  // the moment it completes the person is sent to /mfa-setup like anyone else.
  const isOnboardingApi = isApi && (
    pathname.startsWith('/api/workspace/') ||
    pathname === '/api/team/invite' ||
    pathname === '/api/team/roles'
  )

  // Routes that must stay reachable while a session is still at aal1 with a
  // second factor pending (or not yet enrolled). Each of these enforces its
  // own checks; everything else waits behind the aal2 gate below.
  //
  // FIX (build — Auth independent audit, MEDIUM): `/api/auth/signout` was a
  // startsWith() match, which also exempted /api/auth/signout-others — so a
  // password-only session (second factor still pending) could revoke every
  // other session on the account. The sign-out exemption is now an exact match.
  // (/api/auth/password-changed is retired: the DB audits password changes itself.)
  const isMfaFlowRoute =
    pathname.startsWith('/mfa-challenge') ||
    pathname.startsWith('/mfa-setup') ||
    pathname.startsWith('/api/auth/mfa/') ||
    pathname === '/api/auth/signout' ||
    pathname.startsWith('/api/auth/login-event')

  // Unauthenticated: API callers get a JSON 401 (a redirect to the login page
  // made fetch() clients try to parse HTML), pages get the login redirect —
  // keeping the query string so deep links survive the round trip.
  if (!user && !isAuthRoute && !isPublicRoute && !isOnboarding) {
    if (isApi) {
      return finalize(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname + search)
    return finalize(NextResponse.redirect(loginUrl))
  }

  // Memoised gate lookup — at most one RPC per request, and only on the paths
  // that actually need it.
  let gatePromise: Promise<GateState | null> | null = null
  function loadGate(): Promise<GateState | null> {
    if (!gatePromise) {
      gatePromise = (async () => {
        const { data, error } = await (supabase as any).rpc('middleware_gate_state', {
          p_mfa_permissions: MFA_REQUIRED_PERMISSIONS,
        })
        if (error || !data) {
          console.error('middleware_gate_state failed:', error?.message ?? 'no data')
          return null
        }
        return data as GateState
      })()
    }
    return gatePromise
  }

  // A deleted account never gets past here (signed out, sent to login).
  async function rejectIfDeleted(): Promise<NextResponse | null> {
    const gate = await loadGate()
    if (!gate?.deleted) return null
    await supabase.auth.signOut()
    if (isApi) return finalize(NextResponse.json({ error: 'Account deleted.' }, { status: 401 }))
    return finalize(NextResponse.redirect(new URL('/login?m=account_deleted', request.url)))
  }

  // ── MFA gate: a session that is aal1 while a verified factor exists must
  // complete the challenge before touching the app.
  //
  // FIX (build — Auth independent audit, MEDIUM): "is a second factor required"
  // was read from getAuthenticatorAssuranceLevel().nextLevel, which supabase-js
  // derives from the user object CACHED IN THE COOKIE, not from the JWT (the old
  // comment claimed otherwise). That cache is only refreshed when the token is,
  // so after backup-code recovery deleted the factor the middleware kept
  // demanding a challenge no factor could satisfy for up to an hour. The
  // getUser() call above already fetched the live user from Supabase Auth, so
  // its factor list is authoritative — the JWT `aal` claim still supplies the
  // CURRENT level.
  let currentLevel: string | null = null
  let nextLevel: string | null = null
  if (user) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    currentLevel = aal?.currentLevel ?? null
    const liveFactors = (user as any).factors as Array<{ status: string }> | undefined
    nextLevel = liveFactors
      ? (liveFactors.some(f => f.status === 'verified') ? 'aal2' : 'aal1')
      : (aal?.nextLevel ?? null)
  }

  if (user && !isPublicRoute && !isMfaFlowRoute) {
    if (currentLevel === 'aal1' && nextLevel === 'aal2') {
      if (isApi) {
        // FIX (deep audit, Auth+MFA re-pass round 3): give this its own `code`,
        // distinct from the must-enroll case below. A caller that only pattern-
        // matched the message text (reset-password/page.tsx did, on /two-factor/i)
        // couldn't tell "you have a factor, go prove it" from "you have no factor,
        // go enroll one" — see that page's own fix note for the loop this caused.
        return finalize(NextResponse.json({ error: 'Two-factor verification required.', code: 'mfa_challenge_required' }, { status: 401 }))
      }
      const url = new URL('/mfa-challenge', request.url)
      url.searchParams.set('next', pathname + search)
      return finalize(NextResponse.redirect(url))
    }
  }

  // Already signed in: bounce away from the auth pages (the reset-password page
  // is the exception — a recovery link lands there with a live session).
  if (user && isAuthRoute && pathname !== '/reset-password') {
    const deleted = await rejectIfDeleted()
    if (deleted) return deleted
    const gate = await loadGate()
    const dest = (gate?.has_workspace && gate.onboarding_complete) ? '/dashboard' : (gate ? '/onboarding' : '/dashboard')
    return finalize(NextResponse.redirect(new URL(dest, request.url)))
  }

  // Onboarding gate for app pages (API routes enforce their own workspace
  // checks via getSession()). The onboarding page itself only needs the
  // deleted-account check.
  if (user && !isPublicRoute && !isAuthRoute && !isApi) {
    const deleted = await rejectIfDeleted()
    if (deleted) return deleted

    if (!isOnboarding && !isMfaFlowRoute) {
      const gate = await loadGate()
      // Fail closed on a lookup error: a redirect to /onboarding here would send
      // already-onboarded users into a loop, and letting the request through
      // would skip the gate — an explicit, retryable 503 is the honest answer.
      if (!gate) return finalize(unavailable())
      if (!gate.has_workspace || !gate.onboarding_complete) {
        return finalize(NextResponse.redirect(new URL('/onboarding', request.url)))
      }
    }
  }

  // ── Mandatory MFA enrolment: an account that holds governance-critical
  // permissions but has no verified factor may only reach the setup flow.
  if (user && !isPublicRoute && !isMfaFlowRoute && !isAuthRoute && !isOnboarding) {
    if (currentLevel === 'aal1' && nextLevel === 'aal1') {
      const gate = await loadGate()
      // Fail CLOSED (this check used to fail open whenever the lookup errored).
      if (!gate) return finalize(unavailable())
      if (gate.must_enroll_mfa && !(isOnboardingApi && !gate.onboarding_complete)) {
        if (isApi) {
          // FIX (deep audit, Auth+MFA re-pass round 3): distinct `code` from the
          // aal2-pending case above — see that fix's comment. This one means
          // "no factor exists to challenge," which needs /mfa-setup, not
          // /mfa-challenge (which has nothing to verify and would bounce right
          // back).
          return finalize(NextResponse.json({ error: 'Two-factor enrollment required for this account.', code: 'mfa_enrollment_required' }, { status: 401 }))
        }
        return finalize(NextResponse.redirect(new URL('/mfa-setup', request.url)))
      }
    }
  }

  return finalize(response)
}

// Session cookies (`sb-…`, excluding the PKCE verifier which is intentionally
// domain-scoped) that arrive TWICE in one request: the host-only cookie the
// current code writes plus a legacy `Domain=` cookie written before the
// domain-scoping change. Deletes are host-only, so the legacy copy could never
// be removed — sign-out left it behind and it shadowed fresh logins. Detected
// from the raw Cookie header (the parsed cookie map collapses duplicates).
function duplicatedSessionCookieNames(request: NextRequest): string[] {
  const raw = request.headers.get('cookie')
  if (!raw || !process.env.NEXT_PUBLIC_COOKIE_DOMAIN) return []
  const counts = new Map<string, number>()
  for (const part of raw.split(';')) {
    const name = part.split('=')[0].trim()
    if (/^sb-[\w.-]+$/.test(name) && !name.endsWith('-code-verifier')) {
      counts.set(name, (counts.get(name) || 0) + 1)
    }
  }
  return Array.from(counts.entries()).filter(([, n]) => n > 1).map(([name]) => name)
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
