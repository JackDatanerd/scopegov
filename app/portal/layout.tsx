import type { Metadata } from 'next'

// FIX (cron/portal audit round 2): portal URLs are bearer-token links — keep them out of search indexes and
// stop the browser leaking the URL in Referer. (next.config.mjs sends the matching response headers; this
// covers the meta tags for anything that ignores headers.)
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children
}
