// lib/supabase/cookie-options.ts
//
// FIX (password reset landing on wrong domain): the PKCE code_verifier
// cookie was being set host-only (e.g. scoped strictly to www.scopegov.app)
// because none of the three Supabase clients (browser, server, middleware)
// passed an explicit cookie domain. When Supabase's hosted /verify endpoint
// (or a Vercel-level www<->apex redirect) landed the user back on a
// *different* host than the one that started the flow — same registrable
// domain, different subdomain — the browser correctly refused to send a
// www-scoped cookie to the apex host (or vice versa), so
// exchangeCodeForSession() had no verifier to check the code against and
// failed exactly like an expired/invalid link.
//
// Setting Domain=.scopegov.app makes the cookie valid across every
// subdomain (scopegov.app, www.scopegov.app, app.scopegov.app, ...), so it
// survives that hop regardless of which host the redirect lands on.
//
// Set NEXT_PUBLIC_COOKIE_DOMAIN=.scopegov.app on Vercel (all environments
// that use the real domain). Leave it unset for local dev — localhost
// cookies must NOT have a Domain attribute or the browser will reject them
// outright.
// FIX (build — Auth independent audit, LOW): `secure` used to be tied to
// NEXT_PUBLIC_COOKIE_DOMAIN being set — the whole options object was
// `undefined` without it, so a deployment missing that one variable (a new
// Vercel project, a preview environment promoted to production) silently
// issued session cookies without the Secure flag. Secure now follows the
// build mode; the cookie domain stays optional.
export function sharedCookieOptions() {
  const domain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN
  return {
    ...(domain ? { domain } : {}),
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  }
}

// FIX (deep audit, Auth+MFA independent re-pass): sharedCookieOptions()
// above is passed as one global `cookieOptions` object to both the server
// and browser Supabase clients, so the wide Domain=.scopegov.app it sets
// was applying to EVERY cookie those clients write — not just the PKCE
// code_verifier cookie this file's own header comment says it exists to
// fix, but the long-lived session/refresh-token cookie too. Combined with
// @supabase/ssr defaulting httpOnly to false (needed so the browser
// client can read its own session), that meant an XSS on ANY subdomain of
// scopegov.app (marketing site, docs, status page — anything sharing the
// registrable domain) could read and exfiltrate the main app's session
// cookie, not just whatever page was actually vulnerable.
//
// Only the code_verifier cookie needs to survive an apex<->www hop — it's
// the one read back mid-redirect, during exchangeCodeForSession(), before
// the app "knows" which host it's really on. The session cookie is set
// and read on whichever single host the user is actually on each time;
// it never needs to cross a subdomain boundary itself. Narrow the domain
// to just that one cookie (@supabase/ssr always names it with a
// `-code-verifier` suffix — see createStorageFromOptions in
// @supabase/ssr's cookies.js) and fall back to a host-only cookie
// (`domain` omitted) for everything else, including the session cookie.
export function domainScopedCookieOptions(name: string, options: CookieOptionsLike): CookieOptionsLike {
  if (name.endsWith('-code-verifier')) return options
  if (!options || !('domain' in options)) return options
  const { domain, ...rest } = options
  return rest
}

type CookieOptionsLike = Record<string, unknown> | undefined
