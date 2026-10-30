import type { MetadataRoute } from 'next'
import { absoluteUrl, collectSitemapPages } from '@/lib/seo/public-pages'

// Public, signed-out pages only — see lib/seo/public-pages.ts for how pages get here (anything under app/(marketing)
// is automatic; dynamic sections like a blog register a source in lib/seo/sources.ts).
//
// Generated once at build time: discovery reads the app/ folder, which does not exist inside the serverless runtime,
// so this must never become a dynamically rendered route.
export const dynamic = 'force-static'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = await collectSitemapPages()
  return pages.map((p) => ({
    url: absoluteUrl(p.path),
    ...(p.lastModified ? { lastModified: p.lastModified } : {}),
  }))
}
