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
