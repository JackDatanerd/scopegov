// Which pages belong in sitemap.xml — and how new ones get there without anyone editing a list.
//
// THE CONVENTION (fail-closed on purpose):
//   • Anything you create under  app/(marketing)/**/page.tsx  is public and is listed automatically. The URL is the
//     folder path with route groups removed:  app/(marketing)/pricing/page.tsx  ->  /pricing
//   • Dynamic routes ( [slug] ) cannot be discovered from the file system. Give them a source in lib/seo/sources.ts
//     (blog posts, case studies, help articles...). One small function, no other wiring.
//   • Nothing outside (marketing) is ever listed unless it is in CORE_PAGES below. That is deliberate: a private page
//     added in the wrong place must never leak into a sitemap. The test in tests/seo-indexing.test.ts fails loudly if a
//     NEW public-looking top-level page exists in app/ that is neither listed nor explicitly marked private, so a
//     marketing page created in the wrong folder cannot silently go unindexed either.
//
// LAST-MODIFIED: git/Vercel checkouts give every file the build time as its mtime, which would stamp every URL as
// "changed" on every deploy and teach crawlers to ignore the field. So a date is only emitted when it is real: a page
// declares it with  export const lastModified = '2026-10-30'  (or a source returns it). No date -> no <lastmod>.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SITE_URL } from './site'
import { SITEMAP_SOURCES } from './sources'

export interface SitemapPage {
  /** Path starting with '/', e.g. '/pricing'. Absolute URLs are not accepted (the host is always SITE_URL). */
  path: string
  /** ISO date or date-time. Omit unless it is the real last-content-change date. */
  lastModified?: string
}

// Public, signed-out pages that live outside (marketing) because they predate it. Keep in sync with isPublicRoute in
// middleware.ts. /login is intentionally absent: it is served with noindex (next.config.mjs) — a sign-in form is not a
// search result. Client-portal links are tokenised and private, so they are not listed either.
export const CORE_PAGES: SitemapPage[] = [
  { path: '/' },
  { path: '/calculator' },
  { path: '/signup' },
  { path: '/legal/privacy' },
  { path: '/legal/terms' },
  { path: '/legal/dpa' },
  { path: '/legal/security' },
  { path: '/legal/cookies' },
]

// Top-level folders/files of app/ that are NOT public marketing surface. Used by the guard test, not by the sitemap.
export const PRIVATE_TOP_LEVEL = new Set([
  '(admin)', '(app)', '(auth)', 'api', 'invite', 'mfa-challenge', 'mfa-setup', 'onboarding', 'portal',
])

const PAGE_FILE = /^page\.(tsx|jsx|ts|js|mdx)$/
// Anchored to a line start so a commented-out or quoted example never counts.
const LAST_MODIFIED_EXPORT = /^[ \t]*export\s+const\s+lastModified\s*(?::\s*string\s*)?=\s*['"`](\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?)['"`]/m

/**
 * 'pricing/page.tsx' under (marketing) -> '/pricing'. Returns null for anything that cannot be a single concrete URL:
 * dynamic segments, private (_x) folders, parallel/intercepting routes.
 */
export function routeFromSegments(segments: string[]): string | null {
  const parts: string[] = []
  for (const seg of segments) {
    if (/^\(.*\)$/.test(seg)) continue // route group: not part of the URL
    if (/^[[@_]/.test(seg) || seg.startsWith('(.')) return null // [dynamic], @slot, _private, (.)intercept
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

export function readLastModified(file: string): string | undefined {
  try {
    const m = readFileSync(file, 'utf8').match(LAST_MODIFIED_EXPORT)
    return m ? m[1] : undefined
  } catch {
    return undefined
  }
}

/** Every static page under <appDir>/(marketing). A missing folder is not an error (it does not exist yet). */
export function discoverMarketingPages(appDir: string): SitemapPage[] {
  const root = join(appDir, '(marketing)')
  if (!existsSync(root)) return []
  const out: SitemapPage[] = []
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), [...segments, entry.name])
      else if (PAGE_FILE.test(entry.name)) {
        const path = routeFromSegments(segments)
        if (path) out.push({ path, lastModified: readLastModified(join(dir, entry.name)) })
      }
    }
  }
  walk(root, [])
  return out
}

/** Normalise, de-duplicate (first one wins, so an explicit lastModified is not lost to a later bare entry) and sort. */
export function mergePages(...lists: SitemapPage[][]): SitemapPage[] {
  const byPath = new Map<string, SitemapPage>()
  for (const list of lists) {
    for (const p of list) {
      if (!p.path.startsWith('/') || p.path.startsWith('//')) throw new Error(`sitemap path must start with a single '/': ${p.path}`)
      const path = p.path.length > 1 ? p.path.replace(/\/+$/, '') : p.path
      const prev = byPath.get(path)
      if (!prev) byPath.set(path, { path, lastModified: p.lastModified })
      else if (!prev.lastModified && p.lastModified) prev.lastModified = p.lastModified
    }
  }
  // Homepage first, then alphabetical: a stable order keeps the diff of sitemap.xml readable.
  return [...byPath.values()].sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)))
}

export function absoluteUrl(path: string): string {
  return path === '/' ? SITE_URL : `${SITE_URL}${path}`
}

export async function collectSitemapPages(appDir = join(process.cwd(), 'app')): Promise<SitemapPage[]> {
  const fromSources = await Promise.all(SITEMAP_SOURCES.map((s) => s()))
  return mergePages(CORE_PAGES, discoverMarketingPages(appDir), ...fromSources)
}
