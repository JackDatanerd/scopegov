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
export function sharedCookieOptions() {
  const domain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN
  return domain ? { domain, sameSite: 'lax' as const, secure: true, path: '/' } : undefined
}
