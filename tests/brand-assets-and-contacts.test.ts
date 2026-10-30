// tests/brand-assets-and-contacts.test.ts
//
// Guards for the homepage brand-asset + contact harmonization: one mark everywhere (the balance scale — the shield is
// ScopeShield's), icon files that are real sizes, a sitemap that crawlers can actually fetch, and only mailboxes that exist.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import sitemap from '@/app/sitemap'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

function pngSize(p: string): [number, number] {
  const b = readFileSync(join(root, p))
  expect(b.subarray(1, 4).toString('ascii'), `${p} is a PNG`).toBe('PNG')
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}

describe('favicon / icon set', () => {
  const sizes: Record<string, [number, number]> = {
    'public/favicon-16x16.png': [16, 16],
    'public/favicon-32x32.png': [32, 32],
    'public/favicon-48x48.png': [48, 48],
    'public/apple-touch-icon.png': [180, 180],
    'public/android-chrome-192x192.png': [192, 192],
    'public/android-chrome-512x512.png': [512, 512],
    'public/mstile-150x150.png': [150, 150],
    'public/android-chrome-maskable-192x192.png': [192, 192],
    'public/android-chrome-maskable-512x512.png': [512, 512],
    'public/og-image.png': [1200, 630],
  }
  it('every PNG has the dimensions its name and metadata promise', () => {
    for (const [p, wh] of Object.entries(sizes)) expect(pngSize(p), p).toEqual(wh)
  })
  it('favicon.ico holds 16, 32 and 48px images', () => {
    const b = readFileSync(join(root, 'public/favicon.ico'))
    expect(b.readUInt16LE(2)).toBe(1) // ICO type
    const n = b.readUInt16LE(4)
    const dims = Array.from({ length: n }, (_, i) => b[6 + i * 16] || 256).sort((a, c) => a - c)
    expect(dims).toEqual([16, 32, 48])
  })
  it('pinned-tab SVG stays pure black (Safari recolours it)', () => {
    const svg = read('public/safari-pinned-tab.svg')
    expect(svg).not.toMatch(/#1A5C3A|#fff/i)
    expect(svg).toMatch(/#000/)
  })
  it('only files meant to be served live in /public (no setup README / .gitkeep)', () => {
    const files = readdirSync(join(root, 'public'))
    expect(files).not.toContain('README.md')
    expect(files).not.toContain('.gitkeep')
  })
  it('the homepage mark is the balance scale, not a shield', () => {
    const src = read('components/marketing/HomeMark.tsx')
    expect(src).not.toMatch(/M8 1\.5 2\.5 3\.6/) // old shield path
    expect(src).toContain('viewBox="0 0 64 64"')
  })
})

describe('manifest + SVG favicon', () => {
  const manifest = JSON.parse(read('public/site.webmanifest')) as { icons: { src: string; sizes: string; purpose?: string }[] }
  it('every manifest icon file exists and matches its declared size', () => {
    for (const ic of manifest.icons) {
      const [w, h] = ic.sizes.split('x').map(Number)
      expect(pngSize('public' + ic.src), ic.src).toEqual([w, h])
    }
  })
  it('has "any" and "maskable" icons as separate entries (never the combined purpose)', () => {
    const purposes = manifest.icons.map((i) => i.purpose)
    expect(purposes).toContain('any')
    expect(purposes).toContain('maskable')
    expect(purposes.every((p) => p === 'any' || p === 'maskable')).toBe(true)
  })
  it('maskable icons are opaque full-bleed (corner pixel is brand green, not transparent)', () => {
    for (const s of [192, 512]) {
      const b = readFileSync(join(root, `public/android-chrome-maskable-${s}x${s}.png`))
      expect(b[25], 'colour type 2 = RGB, no alpha').toBe(2)
    }
  })
  it('icon.svg exists and layout declares it ahead of the .ico fallback', () => {
    expect(existsSync(join(root, 'public/icon.svg'))).toBe(true)
    const layout = read('app/layout.tsx')
    const svgAt = layout.indexOf("'/icon.svg'")
    const icoAt = layout.indexOf("'/favicon.ico'")
    expect(svgAt).toBeGreaterThan(-1)
    expect(icoAt).toBeGreaterThan(svgAt)
    expect(layout).not.toMatch(/favicon\.ico',\s*sizes: 'any'/)
  })
})

describe('sitemap', () => {
  it('lists only public pages on the canonical host, homepage first', async () => {
    const urls = (await sitemap()).map((e) => e.url)
    expect(urls[0]).toBe('https://www.scopegov.app')
    for (const u of urls) {
      expect(u.startsWith('https://www.scopegov.app')).toBe(true)
      expect(u).not.toMatch(/\/(dashboard|projects|clients|settings|team|portal|api)(\/|$)/)
    }
    expect(urls).toContain('https://www.scopegov.app/calculator')
  })
  it('every listed path exists as a route', async () => {
    for (const e of await sitemap()) {
      const path = new URL(e.url).pathname
      if (path === '/') continue
      const hits = ['app', 'app/(auth)', 'app/(marketing)'].map((b) => join(root, b, path, 'page.tsx')).filter(existsSync)
      expect(hits.length, path).toBeGreaterThan(0)
    }
  })
  it('robots.txt points at it and middleware lets signed-out crawlers fetch it', () => {
    expect(read('public/robots.txt')).toContain('Sitemap: https://www.scopegov.app/sitemap.xml')
    const m = read('middleware.ts')
    const lit = m.match(/'\/\(\(\?!([^']+)\)\.\*\)'/)![1].replace(/\\\\/g, '\\')
    const re = new RegExp('^/(?!' + lit + ').*$')
    expect(re.test('/sitemap.xml')).toBe(false)
    expect(re.test('/dashboard')).toBe(true)
  })
})

describe('contact addresses', () => {
  it('only support@ and legal@ are used as public mailboxes', () => {
    const dirs = ['app/legal', 'components/marketing', 'lib/help/articles']
    const walk = (d: string): string[] =>
      readdirSync(join(root, d)).flatMap((n) => {
        const rel = join(d, n)
        return statSync(join(root, rel)).isDirectory() ? walk(rel) : /\.(tsx?|md)$/.test(n) ? [rel] : []
      })
    for (const f of dirs.flatMap(walk)) {
      const found = [...read(f).matchAll(/([a-z0-9._-]+)@scopegov\.app/gi)].map((m) => m[1].toLowerCase())
      for (const name of found) expect(['support', 'legal'], `${f}: ${name}@`).toContain(name)
    }
  })
})
