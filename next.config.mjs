/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // FIX 4B: @react-pdf/renderer replaces puppeteer-core + @sparticuz/chromium
    serverComponentsExternalPackages: ['@react-pdf/renderer'],
    // FIX (stale UI after save): Next 14's client Router Cache keeps a
    // dynamically-rendered segment's RSC payload around for 30s by default
    // and serves it on the next navigation to that route instead of
    // refetching — even after router.refresh() ran at save time. That's why
    // e.g. Guardian sensitivity tier looked like it reverted when navigating
    // away and back, but was always correct on a hard reload (which bypasses
    // this cache entirely). Setting dynamic staleness to 0 forces a fresh
    // server fetch on every navigation to a dynamic route.
    staleTimes: {
      dynamic: 0,
    },
  },
  // FIX (cron/portal audit round 2): the app set NO response security headers, and every portal URL carries a
  // bearer token in its path. Conservative set only — a Content-Security-Policy is deliberately NOT added
  // here: the app loads Tabler icons/fonts from CDNs and Paystack scripts, so a CSP needs to be rolled out
  // in report-only mode first or it will break pages.
  async headers() {
    const baseline = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    ]
    // Public token pages and their APIs: never leak the token via Referer, never be indexed or cached,
    // and never be framed (a signing page is a click-jacking target).
    const tokenPages = [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      { key: 'Cache-Control', value: 'no-store, max-age=0' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ]
    // Signed-out pages that exist for a task, not as search results (a sign-in form, a one-time invite link, a
    // password reset). Sent as a header rather than a robots.txt Disallow on purpose: a crawler that is disallowed
    // never fetches the page, so it never sees a noindex and may still list the bare URL.
    const noIndex = [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]
    return [
      { source: '/:path*', headers: baseline },
      { source: '/portal/:path*', headers: tokenPages },
      { source: '/api/portal/:path*', headers: tokenPages },
      { source: '/:page(login|forgot-password|reset-password|mfa-challenge|mfa-setup|onboarding)', headers: noIndex },
      { source: '/invite/:path*', headers: noIndex },
      { source: '/admin/:path*', headers: noIndex },
    ]
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
    ],
  },
}

export default nextConfig
