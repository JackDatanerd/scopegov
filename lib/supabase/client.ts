'use client'
import { createBrowserClient, type CookieOptions } from '@supabase/ssr'
import { sharedCookieOptions, domainScopedCookieOptions } from './cookie-options'

// FIX (deep audit, Auth+MFA independent re-pass): passing only
// `cookieOptions` (no custom `cookies` methods) meant @supabase/ssr's
// default document.cookie-backed getAll/setAll applied
// sharedCookieOptions()'s wide Domain=.scopegov.app to every cookie this
// client writes, including the long-lived session cookie — not just the
// PKCE code_verifier cookie the domain was actually added for. Supplying
// getAll/setAll explicitly (mirroring @supabase/ssr's own default browser
// implementation — see createStorageFromOptions in its cookies.js) lets
// the domain be narrowed per cookie name the same way the server and
// middleware clients now do.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: sharedCookieOptions(),
      cookies: {
        getAll() {
          if (typeof document === 'undefined') return []
          // FIX (build — Auth independent audit, LOW): decodeURIComponent()
          // throws URIError on a stray '%' — any third-party cookie on the
          // domain (analytics, marketing) with such a value made getAll() throw
          // from EVERY supabase.auth call in the browser. Fall back to the raw
          // string per cookie, like the `cookie` package @supabase/ssr uses by
          // default, and ignore fragments with no name.
          return document.cookie.split(';').map(p => p.trim()).filter(Boolean).flatMap(pair => {
            const idx = pair.indexOf('=')
            if (idx <= 0) return []
            const safeDecode = (v: string) => { try { return decodeURIComponent(v) } catch { return v } }
            return [{ name: safeDecode(pair.slice(0, idx)), value: safeDecode(pair.slice(idx + 1)) }]
          })
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
          if (typeof document === 'undefined') return
          cookiesToSet.forEach(({ name, value, options }) => {
            const opts = domainScopedCookieOptions(name, options) as CookieOptions | undefined
            let cookieStr = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
            if (opts?.domain) cookieStr += `; Domain=${opts.domain}`
            cookieStr += `; Path=${opts?.path || '/'}`
            if (opts?.maxAge !== undefined) cookieStr += `; Max-Age=${opts.maxAge}`
            if (opts?.expires) cookieStr += `; Expires=${new Date(opts.expires as any).toUTCString()}`
            if (opts?.sameSite) cookieStr += `; SameSite=${opts.sameSite}`
            // Only add Secure when explicitly requested (sharedCookieOptions()
            // sets it in production; local dev over http:// leaves it unset,
            // matching @supabase/ssr's own DEFAULT_COOKIE_OPTIONS, which has
            // no `secure` key at all) — forcing it here would break cookie
            // writes on non-HTTPS dev hosts other than localhost.
            if (opts?.secure) cookieStr += `; Secure`
            document.cookie = cookieStr
          })
        },
      },
    }
  )
}
