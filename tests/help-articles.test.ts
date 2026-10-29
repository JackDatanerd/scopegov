// The help centre's content rules. Every article, current and future, passes through these, so an author in any chat
// gets the same guarantees: unique slugs, complete sections, safe inline markup, working links, real related articles.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ARTICLES, getArticle, groupedArticles } from '@/lib/help'
import { HELP_CATEGORIES } from '@/lib/help/categories'
import { parseInline } from '@/components/help/inline'
import { helpPermissionLabel } from '@/lib/help/permission-labels'
import { PAID_PLAN_ORDER } from '@/lib/billing/entitlements'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/** Every string an article renders, so one rule can be applied to all of them. */
function textOf(a: (typeof ARTICLES)[number]): string[] {
  return [
    a.title, a.summary, a.shortAnswer, ...(a.beforeYouStart ?? []),
    ...a.steps.flatMap(s => [s.title, s.body, ...(s.details ?? []), ...(s.watchFor ? [s.watchFor] : [])]),
    ...a.dos, ...a.donts, ...a.problems.flatMap(p => [p.symptom, p.meaning, p.fix]), ...a.whatHappensNext,
  ]
}

describe('help article registry', () => {
  it('has unique, URL-safe slugs', () => {
    const slugs = ARTICLES.map(a => a.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('files every article under a real category', () => {
    const ids = new Set(HELP_CATEGORIES.map(c => c.id))
    for (const a of ARTICLES) expect(ids.has(a.category)).toBe(true)
  })

  it('lists categories only when they have articles, in order', () => {
    const groups = groupedArticles()
    for (const g of groups) expect(g.articles.length).toBeGreaterThan(0)
    expect(groups.flatMap(g => g.articles).length).toBe(ARTICLES.length)
  })

  it('resolves slugs and rejects unknown ones', () => {
    expect(getArticle('first-project')?.title).toMatch(/first project/i)
    expect(getArticle('nope')).toBeNull()
  })
})

describe('every article is complete and consistent', () => {
  for (const a of ARTICLES) {
    describe(a.slug, () => {
      it('fills every required section', () => {
        for (const v of [a.title, a.summary, a.shortAnswer]) expect(v.trim().length).toBeGreaterThan(10)
        expect(a.steps.length).toBeGreaterThanOrEqual(2)
        expect(a.dos.length).toBeGreaterThanOrEqual(2)
        expect(a.donts.length).toBeGreaterThanOrEqual(2)
        expect(a.problems.length).toBeGreaterThanOrEqual(1)
        expect(a.whatHappensNext.length).toBeGreaterThanOrEqual(1)
        for (const s of a.steps) { expect(s.title.trim()).not.toBe(''); expect(s.body.trim()).not.toBe('') }
        for (const p of a.problems) for (const v of [p.symptom, p.meaning, p.fix]) expect(v.trim()).not.toBe('')
      })

      it('uses a valid audience and a real date', () => {
        expect(a.audience.plan === 'all' || (PAID_PLAN_ORDER as readonly string[]).includes(a.audience.plan)).toBe(true)
        for (const p of a.audience.permissions) expect(helpPermissionLabel(p).length).toBeGreaterThan(0)
        expect(a.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(Number.isNaN(Date.parse(a.updated))).toBe(false)
      })

      it('only links to published articles', () => {
        for (const slug of a.related) {
          expect(getArticle(slug), `related slug "${slug}"`).not.toBeNull()
          expect(slug).not.toBe(a.slug)
        }
      })

      it('uses only well-formed markup and in-app links', () => {
        for (const t of textOf(a)) {
          expect(t, 'unbalanced **').toSatisfy((x: string) => (x.match(/\*\*/g) ?? []).length % 2 === 0)
          expect(t, 'raw HTML is not allowed').not.toMatch(/<[a-z/][^>]*>/i)
          for (const part of parseInline(t)) {
            if (part.type === 'link') {
              expect(part.href.startsWith('/') && !part.href.startsWith('//')).toBe(true)
              expect(part.href).not.toMatch(/^\/help\/(?!$)/) // article links go through `related`, so the test can verify them
            }
          }
        }
      })

      it('keeps step time within the title promise when it names minutes', () => {
        const promised = /(\d+)\s*minutes?/i.exec(a.title)
        if (!promised) return
        const total = a.steps.reduce((n, s) => n + (s.minutes ?? 0), 0)
        expect(total).toBeGreaterThan(0)
        expect(total).toBeLessThanOrEqual(Number(promised[1]))
      })
    })
  }
})

describe('inline markup parser', () => {
  it('splits bold labels, in-app links and plain text', () => {
    expect(parseInline('Click **Send** in [Projects](/projects) now')).toEqual([
      { type: 'text', text: 'Click ' }, { type: 'bold', text: 'Send' },
      { type: 'text', text: ' in ' }, { type: 'link', text: 'Projects', href: '/projects' },
      { type: 'text', text: ' now' },
    ])
  })
  it('never turns an external or protocol-relative link into a link', () => {
    for (const bad of ['[x](https://evil.example)', '[x](//evil.example)', '[x](javascript:alert(1))']) {
      expect(parseInline(bad).every(p => p.type !== 'link')).toBe(true)
    }
  })
  it('leaves HTML as inert text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ type: 'text', text: '<img src=x onerror=alert(1)>' }])
  })
})

describe('help is wired into the app', () => {
  it('has a sidebar entry and a command-palette entry', () => {
    expect(read('components/layout/Sidebar.tsx')).toMatch(/href: '\/help'/)
    expect(read('components/layout/CommandPalette.tsx')).toMatch(/href: '\/help'/)
  })
  it('sits behind the signed-in app layout, not the public routes', () => {
    const mw = read('middleware.ts')
    expect(mw).not.toMatch(/startsWith\('\/help/)
    expect(() => read('app/(app)/help/page.tsx')).not.toThrow()
    expect(() => read('app/(app)/help/[slug]/page.tsx')).not.toThrow()
  })
})
