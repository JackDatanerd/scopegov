// lib/utils/safe-redirect.ts
//
// FIX (audit round 3, item #7): app/api/auth/callback/route.ts built its
// post-login redirect as `${origin}${next}` where `next` is an
// unvalidated query parameter that flows all the way from the public
// /login page's own URL (see app/(auth)/login/LoginForm.tsx and
// app/mfa-challenge/page.tsx: `searchParams.get('next')`, no validation)
// through Supabase's `redirectTo` option and back out here as a Location
// header. `${origin}${next}` looks safe against the classic payloads
// (`https://evil.com`, `//evil.com`) because concatenation mangles them
// into a same-origin path rather than a new authority — but a URL
// userinfo payload defeats that: `next = "@evil.com/phish"` produces
// `https://scopegov.app@evil.com/phish`, which the WHATWG URL spec (and
// every major browser) parses as host `evil.com` with `scopegov.app`
// discarded as a username. That's a genuine open redirect: an attacker
// sends `https://scopegov.app/login?next=%40evil.com%2Fphish`, the victim
// authenticates for real against the real login page, and lands on an
// attacker-controlled page immediately after — a classic post-auth
// phishing / credential-harvesting setup.
//
// Fix is a strict allowlist: only same-app, single-leading-slash relative
// paths are accepted. Anything else — a different scheme, a
// protocol-relative `//host`, an embedded `@`, a backslash (some URL
// parsers treat `\` as `/`), or a second leading slash — falls back to a
// safe default instead of being echoed back into a redirect.

const SAFE_DEFAULT = '/dashboard'

export function safeRedirectPath(next: string | null | undefined): string {
  if (!next) return SAFE_DEFAULT
  // Must be a single-leading-slash relative path: not "//host" (protocol
  // relative), not "/\host" (browsers normalize backslash to slash), and
  // must not contain a scheme separator or an "@" (userinfo) anywhere.
  if (
    !next.startsWith('/') ||
    next.startsWith('//') ||
    next.startsWith('/\\') ||
    next.includes('@') ||
    next.includes('://') ||
    /[\x00-\x1f]/.test(next) // control characters (some parsers strip these before re-evaluating the URL)
  ) {
    return SAFE_DEFAULT
  }
  return next
}
