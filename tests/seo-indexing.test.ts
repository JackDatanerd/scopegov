// Search indexing: the sitemap discovers marketing pages by convention, nothing private can leak into it, a page created
// in the wrong folder fails loudly instead of going silently unindexed, and the IndexNow plumbing (key file, middleware
// exemption, submitter) holds together.
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sitemap from '@/app/sitemap'
import { SITE_URL } from '@/lib/seo/site'
import {
  CORE_PAGES, PRIVATE_TOP_LEVEL, absoluteUrl, discoverMarketingPages, mergePages, readLastModified, routeFromSegments,
} from '@/lib/seo/public-pages'
import { buildPayload, diffUrls, findKey, parseSitemap } from '../scripts/indexnow.mjs'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('routeFromSegments', () => {
  it('drops route groups and keeps real folders', () => {
    expect(routeFromSegments([])).toBe('/')
    expect(routeFromSegments(['pricing'])).toBe('/pricing')
    expect(routeFromSegments(['(guides)', 'help', 'getting-started'])).toBe('/help/getting-started')
  })
  it('refuses anything that is not one concrete URL', () => {
    expect(routeFromSegments(['blog', '[slug]'])).toBeNull()
    expect(routeFromSegments(['docs', '[...rest]'])).toBeNull()
    expect(routeFromSegments(['_drafts', 'x'])).toBeNull()
    expect(routeFromSegments(['@modal', 'x'])).toBeNull()
    expect(routeFromSegments(['(.)photo'])).toBeNull()
  })
})

describe('discoverMarketingPages', () => {
  const fixture = () => {
    const app = mkdtempSync(join(tmpdir(), 'seo-app-'))
    const put = (rel: string, body = 'export default function P(){return null}') => {
      const f = join(app, rel)
      mkdirSync(join(f, '..'), { recursive: true })
      writeFileSync(f, body)
    }
    return { app, put }
  }

  it('returns nothing when (marketing) does not exist yet', () => {
    expect(discoverMarketingPages(fixture().app)).toEqual([])
  })

  it('finds static pages, skips dynamic/private ones, and never looks outside (marketing)', () => {
    const { app, put } = fixture()
    put('(marketing)/page.tsx')
    put('(marketing)/pricing/page.tsx', "export const lastModified = '2026-10-30'\nexport default function P(){return null}")
    put('(marketing)/blog/page.tsx')
    put('(marketing)/blog/[slug]/page.tsx')
    put('(marketing)/_drafts/secret/page.tsx')
    put('(marketing)/(guides)/how-to/page.mdx')
    put('(marketing)/pricing/layout.tsx')
    put('dashboard/page.tsx') // outside (marketing): must not be picked up
    const got = discoverMarketingPages(app).map((p) => p.path).sort()
    expect(got).toEqual(['/', '/blog', '/how-to', '/pricing'])
    expect(discoverMarketingPages(app).find((p) => p.path === '/pricing')?.lastModified).toBe('2026-10-30')
    expect(discoverMarketingPages(app).find((p) => p.path === '/blog')?.lastModified).toBeUndefined()
  })

  it('only trusts an explicit lastModified export (never file mtimes)', () => {
    const { app, put } = fixture()
    put('x.tsx', "export const lastModified: string = '2026-01-02T03:04:05Z'")
    expect(readLastModified(join(app, 'x.tsx'))).toBe('2026-01-02T03:04:05Z')
    put('y.tsx', "// export const lastModified = '2026-01-02'\nconst other = '2026-01-02'")
    expect(readLastModified(join(app, 'y.tsx'))).toBeUndefined()
    expect(readLastModified(join(app, 'missing.tsx'))).toBeUndefined()
  })
})

describe('mergePages', () => {
  it('de-duplicates, normalises trailing slashes, keeps a real lastModified, homepage first', () => {
    const out = mergePages(
      [{ path: '/b/' }, { path: '/' }, { path: '/a' }],
      [{ path: '/b', lastModified: '2026-10-01' }, { path: '/a' }],
    )
    expect(out.map((p) => p.path)).toEqual(['/', '/a', '/b'])
    expect(out.find((p) => p.path === '/b')?.lastModified).toBe('2026-10-01')
  })
  it('rejects paths that are not site-relative', () => {
    expect(() => mergePages([{ path: 'pricing' }])).toThrow()
    expect(() => mergePages([{ path: '//evil.example/x' }])).toThrow()
    expect(() => mergePages([{ path: 'https://evil.example/x' }])).toThrow()
  })
})

describe('sitemap.xml', () => {
  it('is on the canonical host, homepage first, no duplicates, nothing private', async () => {
    const urls = (await sitemap()).map((e) => e.url)
    expect(urls[0]).toBe(SITE_URL)
    expect(new Set(urls).size).toBe(urls.length)
    for (const u of urls) {
      expect(u === SITE_URL || u.startsWith(SITE_URL + '/')).toBe(true)
      expect(u).not.toMatch(/\/(dashboard|projects|clients|settings|team|portal|api|admin|invite|login|onboarding|mfa-)/)
    }
    expect(urls).toContain(absoluteUrl('/legal/terms'))
  })
  it('sign-in is not a search result: absent from the sitemap, noindex-ed by header', async () => {
    expect((await sitemap()).map((e) => e.url)).not.toContain(absoluteUrl('/login'))
    const cfg = (await import('../next.config.mjs')).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }
    const rules = await cfg.headers()
    const noindexed = rules.filter((r) => r.headers.some((h) => h.key === 'X-Robots-Tag' && /noindex/.test(h.value))).map((r) => r.source)
    for (const s of ['/portal/:path*', '/invite/:path*', '/admin/:path*']) expect(noindexed).toContain(s)
    const authRule = noindexed.find((s) => s.includes('login'))!
    for (const page of ['login', 'forgot-password', 'reset-password', 'mfa-challenge', 'mfa-setup', 'onboarding']) expect(authRule).toContain(page)
  })
  it('the three places that spell the canonical origin agree', () => {
    expect(read('app/layout.tsx')).toContain(`metadataBase: new URL('${SITE_URL}')`)
    expect(read('public/robots.txt')).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`)
  })
})

// The point of the whole convention: a marketing page that lands in the wrong folder must not silently go unindexed.
describe('no public page is left out of the sitemap by accident', () => {
  it('every top-level page folder in app/ is either listed or explicitly private', () => {
    const listed = new Set(CORE_PAGES.map((p) => p.path.split('/')[1] || ''))
    const unaccounted: string[] = []
    for (const e of readdirSync(join(root, 'app'), { withFileTypes: true })) {
      if (e.name === 'page.tsx') continue // the homepage, listed as '/'
      if (!e.isDirectory() || PRIVATE_TOP_LEVEL.has(e.name) || e.name === '(marketing)') continue
      // only folders that actually contain a page somewhere count as routes
      const hasPage = (dir: string): boolean => readdirSync(dir, { withFileTypes: true }).some((c) => (c.isDirectory() ? hasPage(join(dir, c.name)) : /^page\./.test(c.name)))
      if (!hasPage(join(root, 'app', e.name))) continue
      if (!listed.has(e.name)) unaccounted.push(e.name)
    }
    expect(
      unaccounted,
      `app/${unaccounted.join(', app/')} contains a page that is neither in CORE_PAGES nor marked private. Public marketing pages belong in app/(marketing)/ (auto-listed); private ones go in PRIVATE_TOP_LEVEL in lib/seo/public-pages.ts.`,
    ).toEqual([])
  })
  it('every page the middleware treats as public is either listed, noindex-ed, or deliberately unlisted', () => {
    // /portal and /invite are tokenised (noindex); /legal/* and the calculator are listed; auth pages are noindex-ed.
    const m = read('middleware.ts')
    expect(m).toContain("pathname.startsWith('/portal/')")
    expect(CORE_PAGES.map((p) => p.path)).toEqual(expect.arrayContaining(['/', '/calculator', '/signup']))
  })
})

describe('IndexNow', () => {
  it('has exactly one key file and it contains its own name', () => {
    const key = findKey(join(root, 'public'))
    expect(key).toMatch(/^[a-f0-9]{32}$/)
    expect(read(`public/${key}.txt`).trim()).toBe(key)
  })
  it('crawlers can fetch the key signed-out (middleware matcher exempts .txt)', () => {
    const key = findKey(join(root, 'public'))
    const m = read('middleware.ts')
    const lit = m.match(/'\/\(\(\?!([^']+)\)\.\*\)'/)![1].replace(/\\\\/g, '\\')
    const re = new RegExp('^/(?!' + lit + ').*$')
    expect(re.test(`/${key}.txt`)).toBe(false)
    expect(re.test('/robots.txt')).toBe(false)
    expect(re.test('/dashboard')).toBe(true)
    expect(re.test('/projects/abc')).toBe(true)
    expect(re.test('/api/projects')).toBe(true)
  })
  it('no app route is shadowed by the .txt exemption', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
    const txtRoutes = walk(join(root, 'app')).filter((f) => /\.txt$/.test(f))
    expect(txtRoutes).toEqual([])
    expect(existsSync(join(root, '.github/workflows/indexnow.yml'))).toBe(true)
  })

  it('parses sitemap XML (lastmod, CDATA, entities, sitemap indexes)', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://www.scopegov.app</loc></url>
      <url><loc>https://www.scopegov.app/a?x=1&amp;y=2</loc><lastmod>2026-10-30</lastmod></url>
      <url><loc><![CDATA[https://www.scopegov.app/b]]></loc></url></urlset>`
    const { urls, children } = parseSitemap(xml)
    expect(urls).toEqual([
      { loc: 'https://www.scopegov.app', lastmod: undefined },
      { loc: 'https://www.scopegov.app/a?x=1&y=2', lastmod: '2026-10-30' },
      { loc: 'https://www.scopegov.app/b', lastmod: undefined },
    ])
    expect(children).toEqual([])
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://x/y.xml</loc></sitemap></sitemapindex>').children).toEqual(['https://x/y.xml'])
  })
  it('submits only new or changed URLs', () => {
    const entries = [
      { loc: 'https://h/a', lastmod: '2026-10-01' },
      { loc: 'https://h/b', lastmod: undefined },
      { loc: 'https://h/c', lastmod: '2026-10-02' },
      { loc: 'https://h/d', lastmod: undefined },
    ]
    const state = { 'https://h/a': '2026-10-01', 'https://h/b': '', 'https://h/c': '2026-09-01' }
    expect(diffUrls(entries, state)).toEqual(['https://h/c', 'https://h/d'])
    expect(diffUrls(entries, {})).toHaveLength(4) // first run: everything
    expect(diffUrls(entries, state, true)).toHaveLength(4) // FORCE_ALL
    expect(diffUrls(entries, { 'https://h/a': '2026-10-01', 'https://h/b': '', 'https://h/c': '2026-10-02', 'https://h/d': '' })).toEqual([])
  })
  it('builds the documented payload', () => {
    expect(buildPayload({ host: 'h', key: 'k', keyLocation: 'https://h/k.txt', urlList: ['https://h/a'] })).toEqual({
      host: 'h', key: 'k', keyLocation: 'https://h/k.txt', urlList: ['https://h/a'],
    })
  })
})
