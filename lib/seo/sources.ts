// Sitemap sources for pages whose URLs can't be discovered from the file system — i.e. dynamic routes such as a blog
// (app/(marketing)/blog/[slug]/page.tsx). Static pages under app/(marketing) need NOTHING here; they are picked up by
// folder convention (see lib/seo/public-pages.ts).
//
// To make a blog (or any [slug] section) index itself, add one source:
//
//   import { getAllPosts } from '@/lib/blog/posts'          // however posts are stored: MDX files, a table, a CMS
//
//   export const SITEMAP_SOURCES: SitemapSource[] = [
//     async () => (await getAllPosts()).map((p) => ({ path: `/blog/${p.slug}`, lastModified: p.updatedAt ?? p.publishedAt })),
//   ]
//
// The sitemap is generated at BUILD time (app/sitemap.ts is force-static), so a new post goes live in the sitemap on
// the next deploy — and the IndexNow workflow (.github/workflows/indexnow.yml) tells Bing & co. right after that
// deploy. If posts are published from a database WITHOUT a redeploy, trigger a redeploy (or wire revalidation) when
// one is published; do not switch the sitemap to dynamic rendering without also reading from a runtime-available
// source, because the app/ folder does not exist at runtime on Vercel.
import type { SitemapPage } from './public-pages'

export type SitemapSource = () => SitemapPage[] | Promise<SitemapPage[]>

export const SITEMAP_SOURCES: SitemapSource[] = []
