import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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
    pathname.startsWith('/api/guardian/inbound') ||
    pathname.startsWith('/api/billing/webhook') ||
    pathname.startsWith('/api/cron/') ||
    pathname === '/'

  const isOnboarding = pathname === '/onboarding'

  // ── Not authenticated → redirect to login ─────────────────────────────────
  if (!user && !isAuthRoute && !isPublicRoute && !isOnboarding) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return withRef(NextResponse.redirect(loginUrl))
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
