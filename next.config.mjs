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
    return [
      { source: '/:path*', headers: baseline },
      { source: '/portal/:path*', headers: tokenPages },
      { source: '/api/portal/:path*', headers: tokenPages },
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
